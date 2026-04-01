import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ConversationSession, SlackContext } from "./types";
import { Logger } from "./logger";
import { McpManager } from "./mcp-manager";
import { config } from "./config";
import { UserUtils } from "./user-utils";
import { loadSubagentDefinitions } from "./validation-agent";
import type { ApprovableActionRegistry } from "./approvable-actions";

/** Default max age for inactive session cleanup (30 minutes). */
export const DEFAULT_SESSION_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Determine whether approvable actions should be injected for a given Slack context.
 * Actions are appropriate in DMs, explicit @-mentions, non-ephemeral conditional
 * reply channels, or workflow-triggered messages.
 */
export function shouldInjectActions(
  ctx: Pick<
    SlackContext,
    | "channelType"
    | "explicitMention"
    | "workflowId"
    | "isNonEphemeralConditionalChannel"
  >,
): boolean {
  return (
    ctx.channelType === "im" ||
    !!ctx.explicitMention ||
    !!ctx.workflowId ||
    !!ctx.isNonEphemeralConditionalChannel
  );
}

interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger("ClaudeHandler");
  private mcpManager: McpManager;
  private approvableActionRegistry?: ApprovableActionRegistry;
  private retryOptions: RetryOptions = {
    maxRetries: 3, // Reduced retry attempts for faster failure detection
    initialDelayMs: 2000, // 2 seconds - more time for process cleanup
    backoffMultiplier: 1.5, // Less aggressive backoff for process errors
  };

  constructor(
    mcpManager: McpManager,
    approvableActionRegistry?: ApprovableActionRegistry,
  ) {
    this.mcpManager = mcpManager;
    this.approvableActionRegistry = approvableActionRegistry;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || "direct"}`;
  }

  getSession(
    userId: string,
    channelId: string,
    threadTs?: string,
  ): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(
    userId: string,
    channelId: string,
    threadTs?: string,
  ): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async simpleRetry<T>(
    operation: () => Promise<T>,
    onRetry?: (attempt: number) => void,
  ): Promise<T> {
    for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if ((error as any)?.name === "AbortError") throw error;
        if (attempt === this.retryOptions.maxRetries) throw error;

        const delay =
          this.retryOptions.initialDelayMs *
          Math.pow(this.retryOptions.backoffMultiplier, attempt);
        this.logger.warn(
          `Attempt ${attempt + 1} failed, retrying in ${delay}ms`,
        );
        if (onRetry) onRetry(attempt + 1);
        await this.sleep(delay);
      }
    }
    // Unreachable — loop always returns or throws — but satisfies TypeScript
    throw new Error("Retry loop exhausted");
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
    onRetry?: (attempt: number) => void,
    systemPrompt?: string,
  ): AsyncGenerator<SDKMessage, void, unknown> {
    for (
      let globalAttempt = 0;
      globalAttempt <= this.retryOptions.maxRetries;
      globalAttempt++
    ) {
      try {
        yield* await this.executeStreamQueryWithRetry(
          prompt,
          session,
          abortController,
          workingDirectory,
          slackContext,
          onRetry,
          systemPrompt,
        );
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (globalAttempt === this.retryOptions.maxRetries) throw error;

        // Clear session ID to force fresh session on retry
        if (session) {
          this.logger.info("Clearing session ID for fresh retry", {
            sessionId: session.sessionId,
          });
          session.sessionId = undefined;
        }

        const delay =
          this.retryOptions.initialDelayMs *
          Math.pow(this.retryOptions.backoffMultiplier, globalAttempt);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Claude streaming failed (attempt ${globalAttempt + 1}), retrying in ${delay}ms`,
          {
            error: errorMessage,
            attempt: globalAttempt + 1,
            maxRetries: this.retryOptions.maxRetries,
          },
        );
        if (onRetry) onRetry(globalAttempt + 1);
        await this.sleep(delay);
      }
    }
  }

  private async *executeStreamQueryWithRetry(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
    onRetry?: (attempt: number) => void,
    systemPrompt?: string,
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // Configure the Claude SDK options. We no longer bypass the built-in
    // permission checks because we want our `allowedTools` list (defined
    // below) to be fully enforced by the runtime.
    const options: any = {
      outputFormat: "stream-json",
      // Configure the Claude model to use
      model: config.anthropic.model,
      // Disable verbose SDK logging
      verbose: false,
      logLevel: "error", // Only log errors, not debug/info
      // Enable skill discovery from .claude/skills/ directory
      // Skills are available via symlink in the baseDirectory
      settingSources: ["project", "user"],
      // Maximum number of agentic turns before stopping
      maxTurns: 120,
      // NOTE: `permissionMode: "bypassPermissions"` has been removed so that
      // the SDK's own permission gate respects the `allowedTools` list we
      // supply further down. This prevents the assistant from calling tools
      // such as `mcp_github_create_pull_request` which are not explicitly
      // allowlisted in `specificAllowedMcpTools`.
    };

    // Set up system prompt if provided
    // Using the preset to extend Claude Code's default system prompt with our instructions
    if (systemPrompt) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: systemPrompt,
      };
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = { ...mcpServers };
    }

    if (
      this.approvableActionRegistry &&
      slackContext &&
      shouldInjectActions(slackContext)
    ) {
      try {
        const actionSlackCtx = {
          userId: slackContext.user,
          channel: slackContext.channel,
          channelType: slackContext.channelType,
          threadTs: slackContext.threadTs,
          messageTs: slackContext.messageTs || "",
        };
        const actionServers =
          await this.approvableActionRegistry.createMcpServerConfig(
            actionSlackCtx,
          );
        options.mcpServers = {
          ...(options.mcpServers || {}),
          ...actionServers,
        };
      } catch (error) {
        this.logger.error("Failed to create approvable-actions MCP server", {
          error,
        });
      }
    }

    // Set up tool filtering based on user role
    // The SDK handles pattern matching for entries like "Bash(aws:*)"
    let role = "none";
    // Bots and Slack workflows get the highest role from the tool allowlist.
    // Workflow app_mention events may lack both user and workflow_id but still
    // carry bot_id, so check bot/workflow indicators first — before requiring
    // a valid user.
    const isBotOrWorkflow = !!(slackContext?.botId || slackContext?.workflowId);
    if (isBotOrWorkflow) {
      role = (await this.mcpManager.getHighestRole()) || "none";
      this.logger.debug("User role determined (bot/workflow)", {
        userId: slackContext?.user?.slice(-4),
        botId: slackContext?.botId?.slice(-4),
        workflowId: slackContext?.workflowId,
        role,
      });
    } else if (slackContext?.user) {
      role = await UserUtils.getUserRole(slackContext.user);
      this.logger.debug("User role determined", {
        userId: slackContext.user.slice(-4),
        role,
      });
    }

    // Always set allowedTools so the SDK enforces restrictions even when the
    // list is empty (e.g. role "none"). Not setting it at all would let the
    // SDK apply no restrictions.
    const allowedTools = await this.mcpManager.getAllowedTools(role);
    options.allowedTools = allowedTools;
    this.logger.debug("Allowed tools configured", {
      count: allowedTools.length,
      role,
    });

    options.disallowedTools = this.mcpManager.getDisallowedTools();

    // Register sub-agents so the main agent can delegate specialised tasks
    // via the Task tool. Sub-agents run in separate contexts — their tool
    // chatter never leaks into the final response.
    // Pass the same allowedTools so sub-agents have identical permissions.
    options.agents = {
      ...loadSubagentDefinitions(
        allowedTools.length > 0 ? allowedTools : undefined,
      ),
    };

    if (session?.sessionId) {
      options.resume = session.sessionId;
    }

    // Create a generator with simple retry logic
    const generator = await this.simpleRetry(async () => {
      // Use eval to perform dynamic import without TypeScript transforming it
      // into a CommonJS require which would break with ESM-only modules.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore – eval used intentionally to keep dynamic import at runtime
      const { query: claudeQuery } = await eval(
        'import("@anthropic-ai/claude-agent-sdk")',
      );

      return claudeQuery({
        prompt,
        abortController: abortController || new AbortController(),
        options,
      });
    }, onRetry);

    try {
      for await (const message of generator) {
        if (message.type === "system" && message.subtype === "init") {
          if (session) {
            session.sessionId = message.session_id;
          }
        }
        yield message;
      }
    } catch (error) {
      // Log the streaming error with more details
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error("Claude streaming error during message iteration", {
        error: errorMessage,
        stack: errorStack,
        isAbort: error instanceof Error && error.name === "AbortError",
        sessionId: session?.sessionId,
      });

      // Re-throw to be caught by the outer retry mechanism
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = DEFAULT_SESSION_MAX_AGE_MS) {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
      }
    }
  }
}
