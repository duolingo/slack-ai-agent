import { App } from "@slack/bolt";
import { Logger } from "./logger";
import { SlackChannelType } from "./types";
import { CONTEXT_CACHE_TTL_MS } from "./constants";
import { AllowedModel, ChannelModeConfig, EffortLevel } from "./request-mode";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

interface ChannelSettings {
  channelNamePattern: string;
  /** Instruction file (in config/instructions/) appended as channel context. */
  file?: string;
  /** Per-channel Claude model override (one of the AllowedModel literals). */
  model?: AllowedModel;
  /** Per-channel effort override. Dropped for models that don't accept effort (e.g. Haiku). */
  effort?: EffortLevel;
  // fastModePattern and fastModeTagBot are OR — either independently enables fast mode.
  /** Regex tested against the message text; fast mode activates only on match. Use ".*" for always-on. */
  fastModePattern?: string;
  /** Fast mode activates when the user @-mentions the bot. */
  fastModeTagBot?: boolean;
}

interface ConditionalReplyChannel {
  channelNamePattern: string;
  requiredKeywords?: string[]; // Defaults to empty list (matches all messages)
  requiredPatterns?: string[]; // Regex patterns that must ALL match the message text
  allowBotMessages?: boolean;
  allowedWorkflowIds?: string[]; // If set, only respond to these workflow IDs (empty array = block all workflows)
}

/**
 * Proactive "smart reply" configuration. When a channel is eligible, the bot
 * considers replying to messages even without an @-mention or a conditional-reply
 * match — but only after a cheap pre-filter and a final "help or stay silent"
 * check (see SlackHandler.handleSmartReplyCandidate).
 *
 * Smart reply is opt-in: it is enabled only in channels matching an include
 * pattern. An empty/absent include list disables it everywhere; use [".*"] to
 * enable it in every non-conditional channel the bot is in.
 */
interface SmartReplyConfig {
  /** Channels whose name matches one of these patterns are eligible. Empty or
   *  absent disables smart reply everywhere; [".*"] enables it in every
   *  non-conditional channel the bot is in. */
  includeChannelNamePatterns?: string[];
}

interface ChannelConfig {
  /** Per-channel context + model/effort settings. First matching pattern wins. */
  channelSettings: ChannelSettings[];
  conditionalReplyChannels?: ConditionalReplyChannel[];
  ephemeralChannelConfig: Record<string, string[]>;
  dmNotificationConfig: Record<string, string[]>;
  fullContentLoggingAllowlist?: string[];
  smartReply?: SmartReplyConfig;
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

  /** First matching channelSettings entry for the given channel, if any. */
  private async findChannelSettings(
    channelId: string,
    channelType: SlackChannelType,
  ): Promise<ChannelSettings | undefined> {
    const channelName = await this.getChannelName(channelId, channelType);
    if (!channelName) return undefined;
    const settings = (await this.loadConfig()).channelSettings || [];
    return settings.find(s => {
      try {
        return new RegExp(s.channelNamePattern).test(channelName);
      } catch (error) {
        this.logger.error("Invalid regex in channelSettings", {
          pattern: s.channelNamePattern,
          error,
        });
        return false;
      }
    });
  }

  async getContextSource(
    channelId: string,
    channelType: SlackChannelType,
  ): Promise<string | undefined> {
    return (await this.findChannelSettings(channelId, channelType))?.file;
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
   * Test a channel name against a list of regex patterns. Invalid patterns are
   * logged and skipped (fail-closed for that individual pattern).
   */
  private matchesAnyPattern(
    channelName: string,
    patterns: string[] | undefined,
  ): boolean {
    if (!patterns || patterns.length === 0) return false;
    return patterns.some(pattern => {
      try {
        return new RegExp(pattern).test(channelName);
      } catch (error) {
        this.logger.error("Invalid regex in smartReply config", {
          pattern,
          error,
        });
        return false;
      }
    });
  }

  /**
   * Whether a channel name matches the smart-reply include patterns.
   * Does not check conditional-reply channels — callers that already excluded
   * those should use isSmartReplyEligibleChannelName instead.
   */
  private matchesSmartReplyIncludePatterns(
    channelName: string,
    smartReply: SmartReplyConfig | undefined,
  ): boolean {
    const include = smartReply?.includeChannelNamePatterns;
    if (!include || include.length === 0) return false;
    return this.matchesAnyPattern(channelName, include);
  }

  /**
   * Fast eligibility check when the channel name is already known and the
   * message is not in a conditional-reply channel. Use this in app.message
   * routing to avoid re-fetching the channel name or logging/classifying
   * ineligible channels.
   */
  async isSmartReplyEligibleChannelName(
    channelName: string | undefined,
    channelType: SlackChannelType,
  ): Promise<boolean> {
    if (this.isDirectMessage(channelType) || !channelName) return false;
    const smartReply = (await this.loadConfig()).smartReply;
    return this.matchesSmartReplyIncludePatterns(channelName, smartReply);
  }

  /**
   * Look up the channel type via conversations.info when the event payload
   * doesn't include it (e.g. app_mention events).
   */
  async lookupChannelType(channelId: string): Promise<SlackChannelType> {
    if (!this.app) {
      this.logger.warn(
        "Slack App not set, cannot look up channel type — defaulting to im (most restrictive)",
        { channelId },
      );
      // Default to "im" (most restrictive) to avoid leaking private content in logs/tracking
      return "im";
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
        "Failed to look up channel type — defaulting to im (most restrictive)",
        {
          channelId,
          error,
        },
      );
      // Default to "im" (most restrictive) to avoid leaking private content in logs/tracking
      return "im";
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

  /** Per-channel Claude model / effort / fast-mode override, if configured. */
  async getChannelModelOverride(
    channelId: string,
    channelType: SlackChannelType,
  ): Promise<ChannelModeConfig | undefined> {
    const s = await this.findChannelSettings(channelId, channelType);
    if (!s?.model && !s?.effort && !s?.fastModePattern && !s?.fastModeTagBot)
      return undefined;
    return {
      model: s.model,
      effort: s.effort,
      fastModePattern: s.fastModePattern,
      fastModeTagBot: s.fastModeTagBot,
    };
  }

  /**
   * Get the general response guidelines context
   */
  async getGeneralContext(): Promise<string> {
    const context = await this.loadGeneralContext();
    return `\n\n${context}\n`;
  }

  async getGeneralContextForChannel(
    channelType: SlackChannelType | undefined,
    explicitMention?: boolean,
    messageText?: string,
    smartReply?: boolean,
  ): Promise<string> {
    const base = await this.getGeneralContext();

    // Smart-reply turns get the strongest "help or stay silent" contract,
    // regardless of whether the message is phrased as a question — the bot was
    // not addressed, so it must earn its reply by genuinely helping.
    if (smartReply) {
      return `${base}\n\n**SMART REPLY MODE**: You were NOT explicitly mentioned in this channel. Reply ONLY if you can genuinely help — either directly answer a question you're confident about, or take/propose a concrete action with your available tools (e.g. open a PR, file a Jira ticket, look something up). If you cannot help, the message isn't seeking assistance, or it's directed at a specific person, respond with EXACTLY "DO_NOT_RESPOND" and nothing else. Do NOT post "I can't help", do NOT ask clarifying questions just to engage, and do NOT reply to social chatter.`;
    }

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

  async getFullContentLoggingAllowlist(): Promise<Set<string>> {
    const config = await this.loadConfig();
    return new Set(config.fullContentLoggingAllowlist ?? []);
  }

  /**
   * Reload configuration from files (for cache reload command)
   */
  reloadConfiguration(): void {
    this.configCache.clear();
    this.channelNameCache.clear();
  }
}
