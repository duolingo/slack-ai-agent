import type { App } from "@slack/bolt";
import type { ReactionManager } from "../reaction-manager";
import { Logger } from "../logger";
import { generateMessageId } from "../tracking";
import { withMessageId } from "../logger";
import type {
  ApprovableAction,
  ActionSlackContext,
  ActionDependencies,
  PendingActionSession,
} from "./types";

/**
 * Central registry for all approvable actions.
 *
 * Responsibilities:
 * - Registers action definitions at startup
 * - Creates per-request SDK MCP servers (via `createSdkMcpServer`)
 *   that close over Slack context so Claude can call them naturally
 * - Posts Slack confirmation dialogs on tool invocation
 * - Dispatches approve/cancel button clicks to the correct action
 * - Purges stale sessions
 */
export class ApprovableActionRegistry {
  private app: App;
  private reactionManager: ReactionManager;
  private actions = new Map<string, ApprovableAction<any>>();
  private pendingSessions = new Map<string, PendingActionSession>();
  private logger = new Logger("ApprovableActionRegistry");
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(app: App, reactionManager: ReactionManager) {
    this.app = app;
    this.reactionManager = reactionManager;
  }

  // ------------------------------------------------------------------
  // Registration
  // ------------------------------------------------------------------

  register(action: ApprovableAction<any>): void {
    if (this.actions.has(action.name)) {
      this.logger.warn("Overwriting existing action registration", {
        name: action.name,
      });
    }
    this.actions.set(action.name, action);
    this.logger.info("Registered approvable action", { name: action.name });
  }

  // ------------------------------------------------------------------
  // MCP Server creation (per-request)
  // ------------------------------------------------------------------

  /**
   * Build an SDK MCP server config that can be merged into the
   * `options.mcpServers` map passed to `query()`.
   *
   * A *new* server is created every request so the tool handlers
   * can close over the specific `slackContext` for that request.
   */
  async createMcpServerConfig(
    slackContext: ActionSlackContext,
  ): Promise<Record<string, any>> {
    // Dynamic ESM import (same pattern as claude-handler.ts)
    const { createSdkMcpServer, tool } = await eval(
      'import("@anthropic-ai/claude-agent-sdk")',
    );

    const tools: any[] = [];

    for (const action of this.actions.values()) {
      tools.push(
        tool(
          action.name,
          action.description,
          action.inputSchema,
          async (args: any) => {
            return this.handleToolCall(action.name, args, slackContext);
          },
        ),
      );
    }

    const server = createSdkMcpServer({
      name: "approvable-actions",
      tools,
    });

    return { "approvable-actions": server };
  }

  // ------------------------------------------------------------------
  // Tool call handler (posts confirmation dialog)
  // ------------------------------------------------------------------

  private async handleToolCall(
    actionName: string,
    params: any,
    ctx: ActionSlackContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const action = this.actions.get(actionName);
    if (!action) {
      return {
        content: [
          { type: "text" as const, text: `Unknown action: ${actionName}` },
        ],
      };
    }

    const sessionKey = `action-${actionName}-${ctx.userId}-${ctx.channel}-${Date.now()}`;

    // Don't register reactions on the original user message here — the main
    // SlackHandler flow already owns that message's reaction lifecycle. The
    // confirmation dialog itself communicates "waiting for approval."

    // Build confirmation blocks from the action
    const confirmationBlocks = await action.buildConfirmationBlocks(
      params,
      ctx,
    );

    // Add approve/cancel buttons
    const blocks = [
      ...confirmationBlocks,
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "\u2705 Approve",
              emoji: true,
            },
            style: "primary",
            action_id: "approve_action",
            value: `${actionName}:${sessionKey}`,
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "\u274C Cancel",
              emoji: true,
            },
            style: "danger",
            action_id: "cancel_action",
            value: `${actionName}:${sessionKey}`,
          },
        ],
      },
    ];

    // Post the confirmation dialog
    const threadTs = ctx.threadTs || ctx.messageTs;
    const response = await this.app.client.chat.postMessage({
      channel: ctx.channel,
      text: `Confirm: ${actionName}`,
      blocks,
      thread_ts: threadTs,
    });

    // Store session
    this.pendingSessions.set(sessionKey, {
      actionName,
      params,
      ctx,
      messageTs: response.ts,
      createdAt: new Date(),
    });

    this.logger.info("Posted confirmation dialog", {
      actionName,
      sessionKey,
      userId: ctx.userId.slice(-3),
      channel: ctx.channel.slice(-4),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `A confirmation dialog has been posted in the Slack thread. The user must click "Approve" before the action will execute. Do not call this tool again for the same request. Do not send any additional text response to the user — the confirmation dialog is sufficient.`,
        },
      ],
    };
  }

  // ------------------------------------------------------------------
  // Button handlers
  // ------------------------------------------------------------------

  /**
   * Register generic approve_action / cancel_action handlers on the
   * Slack app. Call this once at startup.
   */
  setupButtonHandlers(): void {
    // ---- Approve ----
    this.app.action("approve_action", async ({ ack, body }: any) => {
      await ack();
      const buttonValue = body.actions?.[0]?.value as string | undefined;
      if (!buttonValue) return;

      const { actionName, sessionKey } = this.parseButtonValue(buttonValue);
      const session = this.pendingSessions.get(sessionKey);
      if (!session) {
        this.logger.warn("No pending session for approve", { sessionKey });
        return;
      }

      // Remove session immediately to prevent duplicate approvals
      this.pendingSessions.delete(sessionKey);

      // Build deps with the confirmation dialog's messageTs so the action
      // can update it in-place for status changes
      const confirmChannel = body.container?.channel_id || session.ctx.channel;
      const confirmTs = body.container?.message_ts || session.messageTs;

      const deps: ActionDependencies = {
        app: this.app,
        reactionManager: this.reactionManager,
        confirmationMessageTs: confirmTs,
      };

      const msgId = generateMessageId(
        session.ctx.channel,
        session.ctx.messageTs,
      );
      await withMessageId(msgId, async () => {
        this.logger.info("approve_action clicked", { actionName, sessionKey });

        const action = this.actions.get(actionName);
        if (!action) {
          this.logger.error("Action not found for approve", { actionName });
          return;
        }

        // Update confirmation dialog to show execution started (removes buttons)
        if (confirmChannel && confirmTs) {
          try {
            await this.app.client.chat.update({
              channel: confirmChannel,
              ts: confirmTs,
              text: "Action Approved",
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `\u2705 *Action approved — executing...*`,
                  },
                },
              ],
            });
          } catch (updateErr) {
            this.logger.warn("Failed to update approval message", updateErr);
          }
        }

        try {
          await action.execute(session.params, session.ctx, deps);
        } catch (error) {
          this.logger.error("Action execute failed", { actionName, error });

          // Update the confirmation message with error
          if (confirmChannel && confirmTs) {
            try {
              await this.app.client.chat.update({
                channel: confirmChannel,
                ts: confirmTs,
                text: "Action Failed",
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `\u274C *Action failed*\n\n${
                        error instanceof Error
                          ? error.message.substring(0, 1500)
                          : "Unknown error"
                      }`,
                    },
                  },
                ],
              });
            } catch (updateErr) {
              this.logger.error(
                "Failed to update message with error",
                updateErr,
              );
            }
          }
        }
      });
    });

    // ---- Cancel ----
    this.app.action("cancel_action", async ({ ack, body, client }: any) => {
      await ack();
      const buttonValue = body.actions?.[0]?.value as string | undefined;
      if (!buttonValue) return;

      const { actionName, sessionKey } = this.parseButtonValue(buttonValue);
      const session = this.pendingSessions.get(sessionKey);
      if (!session) {
        this.logger.warn("No pending session for cancel", { sessionKey });
        return;
      }

      // Remove session immediately
      this.pendingSessions.delete(sessionKey);

      const cancelDeps: ActionDependencies = {
        app: this.app,
        reactionManager: this.reactionManager,
      };

      const msgId = generateMessageId(
        session.ctx.channel,
        session.ctx.messageTs,
      );
      await withMessageId(msgId, async () => {
        this.logger.info("cancel_action clicked", { actionName, sessionKey });

        // Run optional onCancel hook
        const action = this.actions.get(actionName);
        if (action?.onCancel) {
          try {
            await action.onCancel(session.params, session.ctx, cancelDeps);
          } catch (err) {
            this.logger.warn("onCancel hook failed", { actionName, err });
          }
        }

        // Update the dialog message
        const channel = body.container?.channel_id || session.ctx.channel;
        const messageTs = body.container?.message_ts || session.messageTs;
        if (channel && messageTs) {
          try {
            await client.chat.update({
              channel,
              ts: messageTs,
              text: "Action Cancelled",
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: "\u274C *Action cancelled.*",
                  },
                },
              ],
            });
          } catch (updateErr) {
            this.logger.error("Failed to update cancel message", updateErr);
          }
        }
      });
    });
  }

  // ------------------------------------------------------------------
  // Session cleanup
  // ------------------------------------------------------------------

  /** Start periodic cleanup of stale sessions (older than 1 hour). */
  startSessionCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.pendingSessions.entries()) {
        if (now - session.createdAt.getTime() > 60 * 60 * 1000) {
          this.pendingSessions.delete(key);
        }
      }
    }, 60 * 1000);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private parseButtonValue(value: string): {
    actionName: string;
    sessionKey: string;
  } {
    const colonIdx = value.indexOf(":");
    if (colonIdx === -1) {
      return { actionName: value, sessionKey: value };
    }
    return {
      actionName: value.substring(0, colonIdx),
      sessionKey: value.substring(colonIdx + 1),
    };
  }
}
