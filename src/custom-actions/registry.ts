import { join } from "path";
import type { App } from "@slack/bolt";
import { REACTIONS, type ReactionManager } from "../reaction-manager";
import { Logger } from "../logger";
import { generateMessageId } from "../tracking";
import { withMessageId } from "../logger";
import { config } from "../config";
import { PersistentMap } from "../persistent-map";
import type { SlackBlock } from "../types";
import type {
  CustomAction,
  ActionSlackContext,
  ActionDependencies,
  PendingActionSession,
} from "./types";

/**
 * Central registry for all custom actions.
 *
 * Responsibilities:
 * - Registers action definitions at startup
 * - Creates per-request SDK MCP servers (via `createSdkMcpServer`)
 *   that close over Slack context so Claude can call them naturally
 * - Posts Slack confirmation dialogs on tool invocation
 * - Dispatches approve/cancel button clicks to the correct action
 * - Purges stale sessions
 */
export class CustomActionRegistry {
  private app: App;
  private reactionManager: ReactionManager;
  private actions = new Map<string, CustomAction<any>>();
  private pendingSessions = new PersistentMap<PendingActionSession>(
    join(config.persistDir, "pending-sessions.json"),
  );
  private logger = new Logger("CustomActionRegistry");

  constructor(app: App, reactionManager: ReactionManager) {
    this.app = app;
    this.reactionManager = reactionManager;
  }

  // ------------------------------------------------------------------
  // Registration
  // ------------------------------------------------------------------

  register(action: CustomAction<any>): void {
    if (this.actions.has(action.name)) {
      this.logger.warn("Overwriting existing action registration", {
        name: action.name,
      });
    }
    this.actions.set(action.name, action);
    this.logger.info("Registered custom action", { name: action.name });
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
    filter?: (action: CustomAction<any>) => boolean,
  ): Promise<Record<string, any>> {
    // Dynamic ESM import (same pattern as claude-handler.ts)
    const { createSdkMcpServer, tool } = await eval(
      'import("@anthropic-ai/claude-agent-sdk")',
    );

    const actions = [...this.actions.values()].filter(
      action => !filter || filter(action),
    );
    if (actions.length === 0) {
      return {};
    }

    const byServer = new Map<string, CustomAction<any>[]>();
    for (const action of actions) {
      const serverName = action.mcpServerName ?? "custom-actions";
      const bucket = byServer.get(serverName) ?? [];
      bucket.push(action);
      byServer.set(serverName, bucket);
    }

    const servers: Record<string, any> = {};
    for (const [serverName, serverActions] of byServer) {
      const tools = serverActions.map(action =>
        tool(
          action.name,
          action.description,
          action.inputSchema,
          async (args: any) => {
            return this.handleToolCall(action.name, args, slackContext);
          },
        ),
      );
      servers[serverName] = createSdkMcpServer({
        name: serverName,
        tools,
      });
    }

    return servers;
  }

  // ------------------------------------------------------------------
  // Reaction lifecycle (original user message)
  // ------------------------------------------------------------------

  /**
   * Set the lifecycle reaction on the original user message for a custom
   * action (waiting-on-human → complete / error). Routed through the
   * session-tracked updateReaction so the reaction state stays consistent
   * across the whole lifecycle — including the later approve/cancel, which the
   * reaction session outlives (SlackHandler keeps it ~12h).
   */
  private async setActionReaction(
    ctx: ActionSlackContext,
    emoji: string,
  ): Promise<void> {
    if (ctx.reactionKey) {
      await this.reactionManager.updateReaction(ctx.reactionKey, emoji);
    }
  }

  /**
   * Run a confirmation-flow step; if it throws (e.g. buildConfirmationBlocks or
   * Slack postMessage fails) mark the original message ERROR before rethrowing.
   * Without this the turn stays stuck on the tool-use reaction, since
   * sendResponse cedes the reaction once an custom action is invoked.
   */
  private async runConfirmationStep<T>(
    ctx: ActionSlackContext,
    step: () => Promise<T>,
  ): Promise<T> {
    try {
      return await step();
    } catch (error) {
      this.logger.error("Confirmation flow step failed", error);
      await this.setActionReaction(ctx, REACTIONS.ERROR);
      throw error;
    }
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

    // ---- Immediate execution (no human approval) ----
    if (action.requiresApproval === false) {
      if (!action.invoke) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Action "${actionName}" is misconfigured: requiresApproval is false but invoke is missing.`,
            },
          ],
        };
      }

      try {
        const text = await action.invoke(params, ctx);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("Immediate action invoke failed", {
          actionName,
          message,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Error in ${actionName}: ${message}`,
            },
          ],
        };
      }
    }

    // ---- YOLO-emoji bypass ----
    // If the action declares yoloEmojis and the user's message contains one
    // of them, skip the confirmation dialog and execute immediately. We post
    // a placeholder message in-thread so action.execute() has a Slack message
    // to update in-place with the final result (JIRA ticket link, PR link).
    const matchedYoloEmoji = action.yoloEmojis?.find(e =>
      ctx.messageText?.includes(e),
    );
    if (matchedYoloEmoji) {
      this.logger.info("YOLO bypass triggered", {
        actionName,
        emoji: matchedYoloEmoji,
        userId: ctx.userId,
        channel: ctx.channel,
      });

      const threadTs = ctx.threadTs || ctx.messageTs;
      let confirmationMessageTs: string | undefined;
      try {
        const posted = await this.app.client.chat.postMessage({
          channel: ctx.channel,
          thread_ts: threadTs,
          text: `🚀 YOLO mode (${matchedYoloEmoji}) — executing \`${actionName}\`...`,
        });
        confirmationMessageTs = posted.ts;
      } catch (postErr) {
        this.logger.warn("Failed to post YOLO placeholder message", postErr);
      }

      const deps: ActionDependencies = {
        app: this.app,
        reactionManager: this.reactionManager,
        confirmationMessageTs,
      };

      try {
        await action.execute(params, ctx, deps);
      } catch (error) {
        this.logger.error("YOLO action execute failed", {
          actionName,
          error,
        });
        const errMessage =
          error instanceof Error ? error.message : String(error);

        if (confirmationMessageTs) {
          try {
            await this.app.client.chat.update({
              channel: ctx.channel,
              ts: confirmationMessageTs,
              text: `❌ YOLO action "${actionName}" failed`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text:
                      `❌ *YOLO action \`${actionName}\` failed*\n` +
                      `\`\`\`\n${errMessage.slice(0, 1500)}\n\`\`\``,
                  },
                },
              ],
            });
          } catch (updateErr) {
            this.logger.warn(
              "Failed to update YOLO message with error",
              updateErr,
            );
          }
        }

        await this.setActionReaction(ctx, REACTIONS.ERROR);

        return {
          content: [
            {
              type: "text" as const,
              text: `Action "${actionName}" was auto-approved via ${matchedYoloEmoji} but execution FAILED: ${errMessage}. Do not call this tool again for the same request. Do not send any additional text response to the user — the failure has already been reported to the thread.`,
            },
          ],
        };
      }

      await this.setActionReaction(ctx, REACTIONS.COMPLETE);

      return {
        content: [
          {
            type: "text" as const,
            text: `Action "${actionName}" was auto-approved via ${matchedYoloEmoji} and has been executed. Do not call this tool again for the same request. Do not send any additional text response to the user.`,
          },
        ],
      };
    }

    // ---- Normal confirmation flow ----

    const sessionKey = `action-${actionName}-${ctx.userId}-${ctx.channel}-${Date.now()}`;

    // Don't register reactions on the original user message here — the main
    // SlackHandler flow already owns that message's reaction lifecycle. The
    // confirmation dialog itself communicates "waiting for approval."

    // Build confirmation blocks from the action. Validation failures (e.g.
    // project key not named in chat) are expected — log and return guidance
    // to the agent without setting an ERROR reaction on the user's message.
    let confirmationBlocks: SlackBlock[];
    try {
      confirmationBlocks = await action.buildConfirmationBlocks(params, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.info("Action rejected before confirmation", {
        actionName,
        message,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Cannot proceed with ${actionName}: ${message}`,
          },
        ],
      };
    }

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
    const response = await this.runConfirmationStep<{ ts?: string }>(ctx, () =>
      this.app.client.chat.postMessage({
        channel: ctx.channel,
        text: `Confirm: ${actionName}`,
        blocks,
        thread_ts: threadTs,
      }),
    );

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
      userId: ctx.userId,
      channel: ctx.channel,
    });

    // The bot is now waiting on a human to approve/cancel — reflect that on the
    // original message. The registry owns this reaction until the action
    // resolves (sendResponse defers for custom actions).
    await this.setActionReaction(ctx, REACTIONS.WAITING_ON_HUMAN);

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
    // Let each action register its own block_action listeners (e.g. the
    // per-check Fix buttons that the CI status section renders). Called
    // once at startup so config-side modules don't need access to `app`
    // from index.ts.
    for (const action of this.actions.values()) {
      action.setupActionHandlers?.(this.app);
    }

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
        formState: body.state?.values,
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
          await this.setActionReaction(session.ctx, REACTIONS.ERROR);
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
          // Workflow/bot-triggered sessions carry a synthetic userId (the
          // original event had no human user). A human approval gives us a
          // real identity, so attribute the action to the approver AND drop
          // the workflow/bot markers — that way the approver is treated like
          // any normal user (resolve their real email, or surface the same
          // error a user would get) instead of silently falling back to the
          // service email.
          const execCtx =
            session.ctx.botId || session.ctx.workflowId
              ? {
                  ...session.ctx,
                  userId: body.user?.id || session.ctx.userId,
                  workflowId: undefined,
                  botId: undefined,
                }
              : session.ctx;
          await action.execute(session.params, execCtx, deps);
          await this.setActionReaction(session.ctx, REACTIONS.COMPLETE);
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

          await this.setActionReaction(session.ctx, REACTIONS.ERROR);
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

        await this.setActionReaction(session.ctx, REACTIONS.ERROR);
      });
    });
  }

  // ------------------------------------------------------------------
  // Session cleanup
  // ------------------------------------------------------------------

  /** Periodically purge sessions older than 7 days to prevent the
   *  persisted file from growing unbounded. */
  startSessionCleanup(): void {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.pendingSessions.entries()) {
        if (now - session.createdAt.getTime() > SEVEN_DAYS_MS) {
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
