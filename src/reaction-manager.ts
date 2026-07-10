import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { App } from "@slack/bolt";
import { Logger } from "./logger";
import type { ModeTriggerEmojis } from "./request-mode";

const logger = new Logger("ReactionManager");

// ─── Emoji config loaded from config/emojis.yaml ─────────────────────────────

interface ReactionConfig {
  THINKING: string;
  TOOL_USE: string;
  COMPLETE: string;
  SKIPPED: string;
  WAITING_ON_HUMAN: string;
  ERROR: string;
  SUPPRESSION_EMOJIS: string[];
  MODE_TRIGGERS?: {
    FAST?: string;
    THINK?: string;
    THINK_HARDEST?: string;
  };
}

function loadReactionConfig(): ReactionConfig {
  const configPath = path.resolve("config/emojis.yaml");
  const content = fs.readFileSync(configPath, "utf-8");
  const config = yaml.load(content) as ReactionConfig;
  logger.info("Loaded emoji config");
  return config;
}

const reactionConfig = loadReactionConfig();

/**
 * Semantic reaction names for use throughout the codebase.
 * Emoji names come from config/emojis.yaml (without colons).
 */
export const REACTIONS = {
  THINKING: reactionConfig.THINKING,
  TOOL_USE: reactionConfig.TOOL_USE,
  COMPLETE: reactionConfig.COMPLETE,
  SKIPPED: reactionConfig.SKIPPED,
  WAITING_ON_HUMAN: reactionConfig.WAITING_ON_HUMAN,
  ERROR: reactionConfig.ERROR,
  /** Slack shortcodes that suppress bot replies (with colons added). */
  SUPPRESSION_EMOJIS: reactionConfig.SUPPRESSION_EMOJIS.map(
    name => `:${name}:`,
  ),
} as const;

/** Optional custom-emoji message triggers for resolveMode (see request-mode.ts). */
export const MODE_TRIGGER_EMOJIS: ModeTriggerEmojis = {
  fast: reactionConfig.MODE_TRIGGERS?.FAST
    ? `:${reactionConfig.MODE_TRIGGERS.FAST}:`
    : undefined,
  think: reactionConfig.MODE_TRIGGERS?.THINK
    ? `:${reactionConfig.MODE_TRIGGERS.THINK}:`
    : undefined,
  thinkHardest: reactionConfig.MODE_TRIGGERS?.THINK_HARDEST
    ? `:${reactionConfig.MODE_TRIGGERS.THINK_HARDEST}:`
    : undefined,
};

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
