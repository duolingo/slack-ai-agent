export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type AllowedModel =
  | "claude-opus-4-8"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5"
  | "claude-fable-5";

export interface RequestMode {
  model?: AllowedModel;
  effort?: EffortLevel;
  fast?: boolean;
}

export interface ChannelModeConfig {
  model?: AllowedModel;
  effort?: EffortLevel;
  /** Regex tested against message text; fast mode activates on match. Use ".*" for always-on. */
  fastModePattern?: string;
  /** Fast mode activates when the user @-mentions the bot. */
  fastModeTagBot?: boolean;
}

export const OPUS_MODEL: AllowedModel = "claude-opus-4-8";
export const SONNET_MODEL: AllowedModel = "claude-sonnet-4-6";
export const HAIKU_MODEL: AllowedModel = "claude-haiku-4-5";
export const FABLE_MODEL: AllowedModel = "claude-fable-5";

/**
 * Optional per-deployment Slack emoji shortcodes (with colons, e.g.
 * ":acme-bot-fast:") that trigger the same tiers as the phrases below.
 * Configured in config/emojis.yaml — kept out of this file since it's
 * synced to the public template repo and the emoji names are company-specific.
 */
export interface ModeTriggerEmojis {
  fast?: string;
  thinkHardest?: string;
  think?: string;
}

// First match wins. Longer phrases before shorter ones they contain
// (e.g. "think harder" before "think hard") to avoid substring collisions.
const MODE_TIERS: {
  emojiKey: keyof ModeTriggerEmojis;
  triggers: string[];
  mode: RequestMode;
}[] = [
  {
    emojiKey: "fast",
    triggers: ["think fast"],
    mode: { model: HAIKU_MODEL },
  },
  {
    emojiKey: "thinkHardest",
    triggers: [
      "think hardest",
      "try hardest",
      "think harder",
      "try harder",
      "think dangerously",
    ],
    mode: { model: FABLE_MODEL, effort: "max" },
  },
  {
    emojiKey: "think",
    triggers: ["think hard", "try hard"],
    mode: { effort: "max" },
  },
];

const supportsEffort = (model: string | undefined): boolean =>
  !model?.toLowerCase().includes("haiku");

// Fast mode is Opus-only. `undefined` means the default model (Opus), so it
// qualifies; any explicitly pinned non-Opus model does not.
const supportsFastMode = (model: string | undefined): boolean =>
  model === undefined || model.toLowerCase().includes("opus");

export const resolveMode = (
  text: string | undefined,
  channelMode: ChannelModeConfig | undefined,
  explicitMention?: boolean,
  modeTriggerEmojis?: ModeTriggerEmojis,
): RequestMode => {
  const lower = (text || "").toLowerCase();

  const matched = MODE_TIERS.find(tier => {
    const emoji = modeTriggerEmojis?.[tier.emojiKey];
    return (
      tier.triggers.some(t => lower.includes(t)) ||
      (!!emoji && lower.includes(emoji.toLowerCase()))
    );
  });

  let model = matched?.mode.model ?? channelMode?.model;
  let effort = matched?.mode.effort ?? channelMode?.effort;
  // Either condition independently enables fast mode (OR, not AND).
  let patternMatch = false;
  if (channelMode?.fastModePattern) {
    try {
      patternMatch = new RegExp(channelMode.fastModePattern, "i").test(
        text || "",
      );
    } catch {
      // Invalid regex in config — fail open (no fast mode) rather than crashing.
    }
  }
  let fast = (channelMode?.fastModeTagBot && explicitMention) || patternMatch;

  // When a trigger only sets effort (no model), release a channel Haiku pin
  // so the effort can actually take effect.
  if (matched && !matched.mode.model && effort && !supportsEffort(model)) {
    model = undefined;
  }
  if (!supportsEffort(model)) effort = undefined;
  if (!supportsFastMode(model)) fast = false;

  return {
    ...(model && { model }),
    ...(effort && { effort }),
    ...(fast && { fast: true }),
  };
};
