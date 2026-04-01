import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { App } from "@slack/bolt";
import { Logger } from "./logger";

const logger = new Logger("ReactionManager");

// ─── Reaction config loaded from config/reactions.yaml ──────────────────────

interface ReactionConfig {
  THINKING: string;
  TOOL_USE: string;
  COMPLETE: string;
  SKIPPED: string;
  ERROR: string;
  SUPPRESSION_EMOJIS: string[];
}

function loadReactionConfig(): ReactionConfig {
  const configPath = path.resolve("config/reactions.yaml");
  const content = fs.readFileSync(configPath, "utf-8");
  const config = yaml.load(content) as ReactionConfig;
  logger.info("Loaded reaction config");
  return config;
}

const reactionConfig = loadReactionConfig();

/**
 * Semantic reaction names for use throughout the codebase.
 * Emoji names come from config/reactions.yaml (without colons).
 */
export const REACTIONS = {
  THINKING: reactionConfig.THINKING,
  TOOL_USE: reactionConfig.TOOL_USE,
  COMPLETE: reactionConfig.COMPLETE,
  SKIPPED: reactionConfig.SKIPPED,
  ERROR: reactionConfig.ERROR,
  /** Slack shortcodes that suppress bot replies (with colons added). */
  SUPPRESSION_EMOJIS: reactionConfig.SUPPRESSION_EMOJIS.map(
    name => `:${name}:`,
  ),
} as const;

// ─── ReactionManager ────────────────────────────────────────────────────────

export class ReactionManager {
  private app: App;
  private logger = new Logger("ReactionManager");
  private currentReactions: Map<string, string> = new Map();
  private originalMessages: Map<string, { channel: string; ts: string }> =
    new Map();

  constructor(app: App) {
    this.app = app;
  }

  registerMessage(sessionKey: string, channel: string, ts: string): void {
    this.originalMessages.set(sessionKey, { channel, ts });
  }

  /**
   * Update the reaction on a message. The emoji parameter should be a
   * Slack emoji name from REACTIONS (e.g. REACTIONS.THINKING).
   */
  async updateReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) return;

    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) return;

    try {
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
        } catch {
          // Reaction might not exist
        }
      }

      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      this.currentReactions.set(sessionKey, emoji);
    } catch (error) {
      this.logger.warn("Failed to update message reaction", error);
    }
  }

  cleanupSession(sessionKey: string): void {
    this.originalMessages.delete(sessionKey);
    this.currentReactions.delete(sessionKey);
  }
}
