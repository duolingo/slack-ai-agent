export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  /** Per-thread sandbox cwd under /tmp/slack-ai-agent/workspaces/. */
  workingDirectory: string;
  lastActivity: Date;
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  url_private: string;
  url_private_download: string;
  size: number;
}

export type SlackChannelType = "im" | "mpim" | "channel" | "group";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlackBlock = any;

export interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  blocks?: SlackBlock[];
  files?: SlackFile[];
  bot_id?: string;
  workflow_id?: string;
  subtype?: string;
  explicitMention?: boolean;
  replyBroadcast?: boolean;
  channel_type: SlackChannelType;
}

export interface SlackContext {
  channel: string;
  channelType: SlackChannelType;
  threadTs?: string;
  user: string;
  botId?: string;
  workflowId?: string;
  messageTs?: string;
  /** Raw text of the incoming Slack message (used for emoji-based bypasses). */
  messageText?: string;
  explicitMention?: boolean;
  replyBroadcast?: boolean;
  /** True when the channel is a non-ephemeral conditional reply channel
   *  (the bot is the primary responder and messages are directed at it). */
  isNonEphemeralConditionalChannel?: boolean;
  /** SlackHandler reaction key for this message. Only set when bot lifecycle
   *  reactions are enabled (non-ephemeral contexts), so approvable actions can
   *  update the reaction through the session path while the turn is live. */
  reactionKey?: string;
  /** Per-thread agent workspace; used for cwd and sandbox writes. */
  workingDirectory?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type PhaseTimings = Record<string, number>;
