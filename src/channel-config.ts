import { App } from "@slack/bolt";
import { Logger } from "./logger";
import { SlackChannelType } from "./types";
import { CONTEXT_CACHE_TTL_MS } from "./constants";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

interface ContextSourcePattern {
  channelNamePattern: string;
  file: string;
}

interface ConditionalReplyChannel {
  channelNamePattern: string;
  requiredKeywords?: string[]; // Defaults to empty list (matches all messages)
  requiredPatterns?: string[]; // Regex patterns that must ALL match the message text
  allowBotMessages?: boolean;
  allowedWorkflowIds?: string[]; // If set, only respond to these workflow IDs (empty array = block all workflows)
}

interface ChannelConfig {
  contextSources: ContextSourcePattern[];
  conditionalReplyChannels?: ConditionalReplyChannel[];
  ephemeralChannelConfig: Record<string, string[]>;
  dmNotificationConfig: Record<string, string[]>;
}

export class ChannelConfigManager {
  private logger = new Logger("ChannelConfigManager");
  private configCache: Map<string, { data: any; fetchedAt: number }> =
    new Map();
  private channelNameCache: Map<string, { name: string; fetchedAt: number }> =
    new Map();
  private readonly CACHE_TTL_MS = CONTEXT_CACHE_TTL_MS;
  private app: App | null = null;

  setApp(app: App): void {
    this.app = app;
  }

  async getChannelName(
    channelId: string,
    channelType: SlackChannelType,
  ): Promise<string | undefined> {
    // DM channels don't have names, return placeholder for tracking
    if (this.isDirectMessage(channelType)) {
      return "direct-message";
    }

    // Check cache
    const cached = this.channelNameCache.get(channelId);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.name;
    }

    // Need Slack App to resolve channel name
    if (!this.app) {
      this.logger.warn("Slack App not set, cannot resolve channel name", {
        channelId,
      });
      return undefined;
    }

    try {
      const result = await this.app.client.conversations.info({
        channel: channelId,
      });
      const name = result.channel?.name;
      if (name) {
        this.channelNameCache.set(channelId, {
          name,
          fetchedAt: Date.now(),
        });
        return name;
      }
    } catch (error) {
      this.logger.warn("Failed to get channel name", { channelId, error });
    }

    return undefined;
  }

  private async loadConfig(): Promise<ChannelConfig> {
    const cacheKey = "channels.yaml";
    const now = Date.now();

    const cached = this.configCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.data as ChannelConfig;
    }

    const configContent = fs.readFileSync(
      path.resolve("config/channels.yaml"),
      "utf-8",
    );
    const loadedConfig = yaml.load(configContent) as ChannelConfig;

    this.configCache.set(cacheKey, { data: loadedConfig, fetchedAt: now });
    this.logger.debug("Loaded channel config from local file");
    return loadedConfig;
  }

  private async loadGeneralContext(): Promise<string> {
    const cacheKey = "general-context.txt";
    const now = Date.now();

    const cached = this.configCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.data as string;
    }

    const context = fs.readFileSync(
      path.resolve("config/instructions/general-context.txt"),
      "utf-8",
    );
    this.configCache.set(cacheKey, { data: context, fetchedAt: now });
    this.logger.debug("Loaded general context from local file");
    return context;
  }

  async getContextSource(
    channelId: string,
    channelType: SlackChannelType,
  ): Promise<string | undefined> {
    const channelName = await this.getChannelName(channelId, channelType);
    if (!channelName) {
      this.logger.debug("Could not resolve channel name for context lookup", {
        channelId,
      });
      return undefined;
    }

    const loadedConfig = await this.loadConfig();
    const contextSources = loadedConfig.contextSources;

    // Iterate through patterns and find a match
    for (const source of contextSources) {
      try {
        const regex = new RegExp(source.channelNamePattern);
        if (regex.test(channelName)) {
          this.logger.debug("Matched channel name to context source", {
            channelName,
            pattern: source.channelNamePattern,
            file: source.file,
          });
          return source.file;
        }
      } catch (regexError) {
        this.logger.error("Invalid regex pattern in context source", {
          pattern: source.channelNamePattern,
          error: regexError,
        });
      }
    }

    this.logger.debug("No matching context source found for channel", {
      channelName,
      channelId,
    });
    return undefined;
  }

  /**
   * Check if a channel is configured for conditional replies (matches any conditionalReplyChannels pattern)
   */
  async isConditionalReplyChannel(
    channelId: string,
    channelType: SlackChannelType,
  ): Promise<boolean> {
    const channelName = await this.getChannelName(channelId, channelType);
    if (!channelName) {
      return false;
    }
    const pattern = await this.findMatchingConditionalChannel(channelName);
    return pattern !== null;
  }

  /**
   * Look up the channel type via conversations.info when the event payload
   * doesn't include it (e.g. app_mention events).
   */
  async lookupChannelType(channelId: string): Promise<SlackChannelType> {
    if (!this.app) {
      this.logger.warn(
        "Slack App not set, cannot look up channel type — defaulting to channel",
        { channelId },
      );
      return "channel";
    }

    try {
      const result = await this.app.client.conversations.info({
        channel: channelId,
      });
      const ch = result.channel;
      if (ch?.is_im) return "im";
      if (ch?.is_mpim) return "mpim";
      if (ch?.is_private) return "group";
      return "channel";
    } catch (error) {
      this.logger.warn(
        "Failed to look up channel type — defaulting to channel",
        {
          channelId,
          error,
        },
      );
      return "channel";
    }
  }

  /**
   * Check if a message is a direct message
   */
  isDirectMessage(channelType: SlackChannelType | undefined): boolean {
    return channelType === "im";
  }

  /**
   * Check if a channel is a conditional reply channel that does not use ephemeral messaging.
   */
  async isNonEphemeralConditionalChannel(
    channelId: string,
    channelType: SlackChannelType,
  ): Promise<boolean> {
    const channelName = await this.getChannelName(channelId, channelType);
    const isConditional =
      !!(await this.findMatchingConditionalChannel(channelName));
    return (
      isConditional && !(await this.shouldUseEphemeralMessaging(channelId))
    );
  }

  async shouldUseEphemeralMessaging(channelId: string): Promise<boolean> {
    const loadedConfig = await this.loadConfig();
    return channelId in loadedConfig.ephemeralChannelConfig;
  }

  async getEphemeralTargetUsers(channelId: string): Promise<string[]> {
    const loadedConfig = await this.loadConfig();
    const targets = loadedConfig.ephemeralChannelConfig[channelId] || [];
    return targets.filter(target => target.startsWith("U"));
  }

  async getEphemeralTargetChannels(channelId: string): Promise<string[]> {
    const loadedConfig = await this.loadConfig();
    const targets = loadedConfig.ephemeralChannelConfig[channelId] || [];
    return targets.filter(
      target => target.startsWith("C") || target.startsWith("D"),
    );
  }

  async shouldSendDM(channelId: string, userId: string): Promise<boolean> {
    const loadedConfig = await this.loadConfig();
    const dmUsers = loadedConfig.dmNotificationConfig?.[channelId] || [];
    return dmUsers.includes(userId);
  }

  /**
   * Find a conditional reply channel config that matches the given channel name
   */
  async findMatchingConditionalChannel(
    channelName?: string,
    messageText?: string,
    workflowId?: string,
  ): Promise<ConditionalReplyChannel | null> {
    if (!channelName) {
      return null;
    }

    const config = await this.loadConfig();
    const channels = config.conditionalReplyChannels || [];

    for (const channel of channels) {
      try {
        const regex = new RegExp(channel.channelNamePattern);
        if (
          regex.test(channelName) &&
          this.isWorkflowAllowed(channel, workflowId) &&
          (messageText === undefined ||
            this.matchesConditionalReplyRequirements(channel, messageText))
        ) {
          return channel;
        }
      } catch (error) {
        this.logger.error(
          "Invalid regex pattern in conditionalReplyChannels config",
          {
            pattern: channel.channelNamePattern,
            error,
          },
        );
        continue;
      }
    }

    return null;
  }

  /**
   * Check if a message matches the conditional reply requirements for a channel config
   */
  matchesConditionalReplyRequirements(
    channelConfig: ConditionalReplyChannel,
    messageText: string,
  ): boolean {
    const keywords = channelConfig.requiredKeywords || [];
    if (!keywords.every(keyword => messageText.includes(keyword))) {
      return false;
    }
    const patterns = channelConfig.requiredPatterns || [];
    return patterns.every(pattern => new RegExp(pattern).test(messageText));
  }

  /**
   * Check if a workflow ID is allowed for a channel config
   * Returns true if: allowedWorkflowIds is not set (undefined), or workflowId is in the list
   * Returns false if: allowedWorkflowIds is set and workflowId is not in the list (including empty array)
   */
  isWorkflowAllowed(
    channelConfig: ConditionalReplyChannel,
    workflowId?: string,
  ): boolean {
    // If allowedWorkflowIds is not configured, allow all (including non-workflow messages)
    if (channelConfig.allowedWorkflowIds === undefined) {
      return true;
    }

    // If it's not a workflow message, allow it (this filter only applies to workflows)
    if (!workflowId) {
      return true;
    }

    // Check if this workflow ID is in the allowed list
    return channelConfig.allowedWorkflowIds.includes(workflowId);
  }

  /**
   * Determine if the bot should handle a message in this channel
   */
  async shouldHandleMessage(
    channelId: string,
    isDM: boolean,
    isMentioned: boolean,
    messageText?: string,
    channelName?: string,
    workflowId?: string,
  ): Promise<boolean> {
    if (isDM) return true;

    const match = await this.findMatchingConditionalChannel(
      channelName,
      messageText,
      workflowId,
    );
    if (match) return true;

    return isMentioned;
  }

  /**
   * Get the general response guidelines context
   */
  async getGeneralContext(): Promise<string> {
    const context = await this.loadGeneralContext();
    return `\n\n${context}\n`;
  }

  async getGeneralContextForChannel(
    channelId: string,
    channelType: SlackChannelType | undefined,
    explicitMention?: boolean,
    messageText?: string,
  ): Promise<string> {
    const base = await this.getGeneralContext();
    // Skip DO_NOT_RESPOND logic if: DM, explicit mention, or message has a question mark
    if (
      this.isDirectMessage(channelType) ||
      explicitMention ||
      messageText?.includes("?")
    ) {
      return base;
    }
    return `${base}\n\n**NOTE**: If not a question or the user doesn't seem to need help: respond exactly "DO_NOT_RESPOND" (Unless it's a pagerduty / incident / session completion rate too low alert where alert-triage skill should be used.)`;
  }

  /**
   * Reload configuration from files (for cache reload command)
   */
  reloadConfiguration(): void {
    this.configCache.clear();
    this.channelNameCache.clear();
  }
}
