import { SlackChannelType, PhaseTimings } from "./types";

// ─── Event types ────────────────────────────────────────────────────────────

export interface MessageProcessedEvent {
  /** Slack member id (U…) — used with employees.json-derived data to set tracking distinct_id. */
  slackUserId?: string;
  slackUsername: string;
  slackHandle?: string | null;
  slackChannel: string;
  slackChannelType: SlackChannelType;
  slackChannelName?: string;
  slackThreadTs?: string;
  slackMessageLink: string;
  slackAppQuestion: string;
  slackAppAnswer: string;
  latencyMs: number;
  toolCalls?: string[];
  toolCallNames?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUsd?: number;
  turnCount?: number;
  phaseTimings?: PhaseTimings;
  isOpusFastMode?: boolean;
  /** true when the bot proactively replied without an @-mention (smart-reply path) */
  isSmartReply?: boolean;
  /** false when the agent explicitly returned DO_NOT_RESPOND */
  agentCouldHelp?: boolean;
}

export interface MessageClassificationEvent {
  slackUserId?: string;
  slackUsername: string;
  slackHandle?: string | null;
  slackChannel: string;
  slackChannelType: SlackChannelType;
  slackChannelName?: string;
  slackThreadTs?: string;
  slackMessageLink: string;
  slackAppQuestion: string;
  latencyMs: number;
  costUsd?: number;
  /** true = classifier YES, false = classifier NO */
  couldHelp: boolean;
}

export interface FeedbackEvent {
  slackUserId?: string;
  slackUsername: string;
  slackHandle?: string | null;
  slackChannel: string;
  slackChannelType: SlackChannelType;
  slackChannelName?: string;
  slackThreadTs?: string;
  slackMessageLink: string;
  upvoteStatus: "upvote" | "downvote" | "ok" | "delete";
  upvoteTargetType: string;
  slackAppQuestion?: string;
  slackAppAnswer?: string;
}

// ─── EventHandler interface ─────────────────────────────────────────────────

/** Interface for handling tracking events. Implement this to customize where events are sent. */
export interface EventHandler {
  onMessageProcessed(event: MessageProcessedEvent): Promise<void>;
  onMessageClassification(event: MessageClassificationEvent): Promise<void>;
  onFeedback(event: FeedbackEvent): Promise<void>;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Generate a short message ID for logging (e.g., "1TGA-9439") */
export const generateMessageId = (
  channel?: string,
  messageTs?: string,
): string => {
  if (channel && messageTs) {
    const channelShort = channel.slice(-4);
    const timestampShort = messageTs.replace(".", "").slice(-4);
    return `${channelShort}-${timestampShort}`;
  } else if (channel) {
    const channelShort = channel.slice(-4);
    return `${channelShort}-xxxx`;
  }
  return `msg-${Date.now().toString().slice(-6)}`;
};

/** Helper to truncate text for storage */
export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
};
