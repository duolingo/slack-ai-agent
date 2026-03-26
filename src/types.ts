export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
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
  explicitMention?: boolean;
  replyBroadcast?: boolean;
  /** True when the channel is a non-ephemeral conditional reply channel
   *  (the bot is the primary responder and messages are directed at it). */
  isNonEphemeralConditionalChannel?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}
