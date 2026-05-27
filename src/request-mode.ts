export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Allowed Claude model identifiers, restricted to the model families we
 * currently support. Strings match Anthropic's canonical IDs:
 * https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
 */
export type AllowedModel =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5";

export interface RequestMode {
  model?: AllowedModel;
  /** Effort level. Dropped when the resolved model can't accept it (Haiku). */
  effort?: EffortLevel;
}

/** Haiku does not support the `effort` parameter. */
export const HAIKU_MODEL: AllowedModel = "claude-haiku-4-5";

const MAX_EFFORT_TRIGGERS = [":duo-ai-bot-think:", "think hard", "try hard"];
const FAST_TRIGGERS = [":duo-ai-bot-fast:", "think fast"];

const supportsEffort = (model: string | undefined): boolean =>
  !model?.toLowerCase().includes("haiku");

/**
 * Resolve the effective model + effort for a Slack message.
 *
 * Message-level triggers (case-insensitive substring in user text) always
 * override the channel-level default — including releasing a channel's
 * Haiku pin when the user asks for higher effort.
 */
export const resolveMode = (
  text: string | undefined,
  channelMode: RequestMode | undefined,
): RequestMode => {
  const lower = (text || "").toLowerCase();
  const msgFast = FAST_TRIGGERS.some(t => lower.includes(t));
  const msgMax = !msgFast && MAX_EFFORT_TRIGGERS.some(t => lower.includes(t));

  let model = msgFast ? HAIKU_MODEL : channelMode?.model;
  let effort: EffortLevel | undefined = msgMax ? "max" : channelMode?.effort;

  if (msgMax && !supportsEffort(model)) model = undefined;
  if (!supportsEffort(model)) effort = undefined;

  return { ...(model && { model }), ...(effort && { effort }) };
};
