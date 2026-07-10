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
  /** Raw text of the incoming Slack message (used for emoji-based bypasses). */
  messageText?: string;
  workflowId?: string;
  botId?: string;
  /** SlackHandler reaction key. Only set when bot lifecycle reactions are
   *  enabled, so the registry can update the original message's reaction
   *  through the session path while the turn is live (before cleanup). */
  reactionKey?: string;
  /** Per-thread agent workspace for temp files the action subprocess reads. */
  workingDirectory?: string;
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
  /** Form state from the confirmation dialog at approval time — Slack's
   *  `body.state.values`, keyed by block_id then action_id. Lets actions
   *  read user-toggled inputs (checkboxes, selects) embedded in their
   *  confirmation blocks. Undefined for YOLO-bypass executions. */
  formState?: Record<string, Record<string, any>>;
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
  /** Optional. Register Slack app event handlers (e.g. block_actions for
   *  buttons rendered in messages this action posts) once at startup. The
   *  registry calls this for each registered action right after it wires
   *  up the generic approve/cancel handlers. */
  setupActionHandlers?(app: App): void;
  /** Optional list of Slack emoji shortcodes (e.g. [":yolo-jira:", ":yolo-pr:"]).
   *  When any of them is present in the user's message text the confirmation
   *  dialog is skipped and the action executes immediately. */
  yoloEmojis?: string[];
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
