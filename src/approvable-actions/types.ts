import type { App } from "@slack/bolt";
import type { ReactionManager } from "../reaction-manager";
import type { SlackBlock, SlackChannelType } from "../types";

/**
 * Slack context captured at the time of the tool call.
 * Passed to every action so it can post messages to the right place.
 */
export interface ActionSlackContext {
  userId: string;
  channel: string;
  channelType: SlackChannelType;
  threadTs?: string;
  messageTs: string;
}

/**
 * Shared dependencies injected into action execute/onCancel.
 */
export interface ActionDependencies {
  app: App;
  reactionManager: ReactionManager;
  /** Timestamp of the confirmation dialog message — actions should update
   *  this message in-place for status changes instead of posting new messages. */
  confirmationMessageTs?: string;
}

/**
 * Every approvable action must implement this interface.
 *
 * TParams is the Zod-inferred parameter type for the MCP tool.
 */
export interface ApprovableAction<TParams> {
  /** MCP tool name suffix (full name becomes mcp__approvable-actions__<name>) */
  name: string;
  /** Claude reads this to decide when to call the tool */
  description: string;
  /** Zod raw shape for the tool input schema */
  inputSchema: Record<string, any>;
  /** Build Slack Block Kit blocks for the confirmation dialog */
  buildConfirmationBlocks(
    params: TParams,
    ctx: ActionSlackContext,
  ): Promise<SlackBlock[]>;
  /** Execute the action after user clicks Approve */
  execute(
    params: TParams,
    ctx: ActionSlackContext,
    deps: ActionDependencies,
  ): Promise<void>;
  /** Optional cleanup when user clicks Cancel */
  onCancel?(
    params: TParams,
    ctx: ActionSlackContext,
    deps: ActionDependencies,
  ): Promise<void>;
}

/**
 * In-memory representation of a pending action awaiting user approval.
 */
export interface PendingActionSession<TParams = unknown> {
  actionName: string;
  params: TParams;
  ctx: ActionSlackContext;
  /** Timestamp of the confirmation dialog message (for chat.update) */
  messageTs?: string;
  createdAt: Date;
}
