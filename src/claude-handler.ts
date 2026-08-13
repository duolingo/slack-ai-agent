import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ConversationSession, SlackContext } from "./types";
import { Logger } from "./logger";
import { bindUserToMcpServers, McpManager } from "./mcp-manager";
import {
  config,
  provisionThreadWorkspace,
  destroyThreadWorkspace,
  buildSandboxFilesystem,
  SANDBOX_NETWORK,
} from "./config";
import { UserUtils } from "./user-utils";
import { loadSubagentDefinitions } from "./validation-agent";
import type { CustomActionRegistry } from "./custom-actions";
import { OPUS_MODEL, RequestMode, SONNET_MODEL } from "./request-mode";
import { OpusHealthMonitor } from "./opus-health";

/** Default max age for inactive session cleanup (16 hours). */
export const DEFAULT_SESSION_MAX_AGE_MS = 16 * 60 * 60 * 1000;

const ALLOWED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  // AWS CLI auth for local testing (duo sso session creds).
  // In prod, credentials come from the EC2 instance profile via IMDS.
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_PROFILE",
  // GCP/BQ CLI auth — bq reads creds from ~/.config/gcloud/ by default.
  // CLOUDSDK_CONFIG overrides the config dir; GOOGLE_APPLICATION_CREDENTIALS
  // points to a service account key file.
  "CLOUDSDK_CONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

// Env for the Claude subprocess, applied over the allowlisted host vars.
// buildSanitizedEnv() replaces the subprocess environment wholesale, so
// these values can't be set via host env vars — change them here.
// See https://code.claude.com/docs/en/env-vars.
const CLAUDE_ENV = {
  // The SDK defaults (200 per session, 3-deep nesting) left the bot open to
  // runaway fan-out — a single session once launched 77 subagents and 13k+ turns.
  CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: "20",
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2",
  // Auto-memory persists conversation content — including from private DMs —
  // to a memory directory that every session then reads back.
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  // Sessions get MCP servers only from mcp-servers.json, which is vetted and
  // pre-resolved by scripts/resolve-mcp-config.sh — never from a claude.ai
  // account the bot happens to be authenticated as.
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  // Per-call MCP tool timeout (ms). The SDK's default is 60s, too short for
  // synchronous data-ai analyses, which routinely run for minutes.
  MCP_TOOL_TIMEOUT: "600000",
  // Token cap on a single MCP tool result. The SDK's default truncates large
  // BigQuery and Grafana payloads. Raising it costs context: a handful of
  // full-size results is a real share of the per-query maxBudgetUsd ceiling.
  MAX_MCP_OUTPUT_TOKENS: "60000",
} as const;

/**
 * Build a sanitized env for the Claude subprocess.
 *
 * Only PATH, HOME, and Anthropic auth credentials are passed. MCP server tokens
 * are no longer needed in the subprocess env because mcp-servers.json is
 * pre-resolved with literal values by scripts/resolve-mcp-config.sh.
 */
export const buildSanitizedEnv = (): Record<string, string | undefined> => {
  const sanitized: Record<string, string | undefined> = {};
  for (const key of ALLOWED_ENV_VARS) {
    if (key in process.env) {
      sanitized[key] = process.env[key];
    }
  }
  // Applied last so a misconfigured runner can't bypass the invariants.
  Object.assign(sanitized, CLAUDE_ENV);
  return sanitized;
};

/**
 * Determine whether custom actions should be injected for a given Slack context.
 * Actions are appropriate in DMs, explicit @-mentions, non-ephemeral conditional
 * reply channels, workflow-triggered messages, or proactive smart-reply turns
 * (so the bot can propose concrete actions like opening a PR without a mention).
 */
export function shouldInjectActions(
  ctx: Pick<
    SlackContext,
    | "channelType"
    | "explicitMention"
    | "workflowId"
    | "isNonEphemeralConditionalChannel"
    | "smartReply"
  >,
): boolean {
  return (
    ctx.channelType === "im" ||
    !!ctx.explicitMention ||
    !!ctx.workflowId ||
    !!ctx.isNonEphemeralConditionalChannel ||
    !!ctx.smartReply
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
  private customActionRegistry?: CustomActionRegistry;
  private opusHealthMonitor: OpusHealthMonitor;
  private retryOptions: RetryOptions = {
    maxRetries: 3, // Reduced retry attempts for faster failure detection
    initialDelayMs: 2000, // 2 seconds - more time for process cleanup
    backoffMultiplier: 1.5, // Less aggressive backoff for process errors
  };

  constructor(
    mcpManager: McpManager,
    customActionRegistry?: CustomActionRegistry,
    opusHealthMonitor: OpusHealthMonitor = new OpusHealthMonitor(),
  ) {
    this.mcpManager = mcpManager;
    this.customActionRegistry = customActionRegistry;
    this.opusHealthMonitor = opusHealthMonitor;
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
    const sessionKey = this.getSessionKey(userId, channelId, threadTs);
    const workingDirectory = provisionThreadWorkspace(sessionKey);
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      workingDirectory,
      lastActivity: new Date(),
    };
    this.sessions.set(sessionKey, session);
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
    slackContext?: SlackContext,
    onRetry?: (attempt: number) => void,
    systemPrompt?: string,
    requestMode?: RequestMode,
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
          slackContext,
          onRetry,
          systemPrompt,
          requestMode,
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
    slackContext?: SlackContext,
    onRetry?: (attempt: number) => void,
    systemPrompt?: string,
    requestMode?: RequestMode,
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // resolveMode has already reconciled model/effort compatibility, so the
    // SDK options can take the values verbatim with a default-model fallback.
    if (requestMode?.model || requestMode?.effort || requestMode?.fast) {
      this.logger.info("Applying request-mode override", { ...requestMode });
    }

    // Configure the Claude SDK options. We no longer bypass the built-in
    // permission checks because we want our `allowedTools` list (defined
    // below) to be fully enforced by the runtime.
    const primaryModel = requestMode?.model || config.anthropic.model;
    const cwd = session?.workingDirectory ?? config.baseDirectory;
    const options: any = {
      outputFormat: "stream-json",
      // Configure the Claude model to use
      model: primaryModel,
      // Disable verbose SDK logging
      verbose: false,
      logLevel: "error", // Only log errors, not debug/info
      // Sanitize the subprocess environment so Claude sessions cannot
      // discover application secrets. MCP tokens are pre-resolved into
      // mcp-servers.json by scripts/resolve-mcp-config.sh and don't need
      // to be in the subprocess env.
      env: buildSanitizedEnv(),
      // Enable skill discovery from .claude/skills/ in the thread workspace
      settingSources: ["project", "user"],
      // Maximum number of agentic turns before stopping. A Data AI job polled
      // every 5s for 25 minutes is ~300 turns on its own.
      maxTurns: 400,
      // Per-query spend ceiling (USD). The estimate accumulates across the
      // top-level loop and all subagent API calls, and the query stops with
      // an error_max_budget_usd result when it's hit.
      maxBudgetUsd: 25,
      // Sandbox Bash commands so they cannot read the repo dir (which
      // contains mcp-servers.json with resolved secrets) or other
      // sensitive paths under $HOME. Read/Edit/Write tools are NOT
      // sandboxed by this — they go through the permission system — but
      // the allowedTools list already restricts those.
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: buildSandboxFilesystem(cwd),
        network: SANDBOX_NETWORK,
      },
      // NOTE: `permissionMode: "bypassPermissions"` has been removed so that
      // the SDK's own permission gate respects the `allowedTools` list we
      // supply further down. This prevents the assistant from calling tools
      // such as `mcp_github_create_pull_request` which are not explicitly
      // allowlisted in `specificAllowedMcpTools`.
    };
    if (requestMode?.effort) options.effort = requestMode.effort;
    // Opus fast mode (faster output, same model). Goes through the SDK's
    // "flag settings" layer via `settings` rather than a top-level option.
    if (requestMode?.fast) {
      options.settings = { ...(options.settings ?? {}), fastMode: true };
    }

    // When the primary model is Opus, let the SDK transparently fall back to
    // Sonnet if Opus is overloaded or unavailable. The SDK re-tries the primary
    // at the start of each user turn, so a temporary outage doesn't permanently
    // demote the session. The OpusHealthMonitor (below) reports when this
    // fallback is actually happening so ops has visibility.
    const isOpusRequest = primaryModel === OPUS_MODEL;
    if (isOpusRequest) {
      options.fallbackModel = SONNET_MODEL;
    }

    // Set up system prompt if provided
    // Using the preset to extend Claude Code's default system prompt with our instructions
    if (systemPrompt) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: systemPrompt,
      };
    }

    options.cwd = cwd;

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      // Identity-bound servers (config `userEmailHeader`) receive the
      // requesting user's email as a trusted per-request header; without a
      // resolvable human requester they are omitted for this request (fail
      // closed). Bot/workflow-triggered messages have no `event.user`, so
      // they never reach identity-bound servers.
      let requesterEmail: string | undefined;
      if (slackContext?.user) {
        const employee = await UserUtils.getEmployeeBySlackId(
          slackContext.user,
        );
        requesterEmail = employee?.email?.trim() || undefined;
      }
      const { servers, omitted } = bindUserToMcpServers(
        mcpServers,
        requesterEmail,
      );
      if (omitted.length > 0) {
        this.logger.debug(
          "Omitted identity-bound MCP servers: no resolvable requester email",
          { omitted, userId: slackContext?.user },
        );
      }
      options.mcpServers = servers;
    }

    if (this.customActionRegistry && slackContext) {
      try {
        const actionSlackCtx = {
          // Workflow/bot-triggered messages have no `event.user`, so
          // `slackContext.user` is undefined. Fall back to the bot/workflow
          // identifier (or a literal) so downstream actions never crash on
          // `ctx.userId.slice(...)` / username sanitization. The Approve
          // handler later swaps in the human approver's id (see registry.ts).
          userId:
            slackContext.user ||
            slackContext.botId ||
            slackContext.workflowId ||
            "slack-workflow",
          channel: slackContext.channel,
          channelType: slackContext.channelType,
          threadTs: slackContext.threadTs,
          messageTs: slackContext.messageTs || "",
          messageText: slackContext.messageText,
          threadUserText: slackContext.threadUserText,
          workflowId: slackContext.workflowId,
          botId: slackContext.botId,
          reactionKey: slackContext.reactionKey,
          workingDirectory: session?.workingDirectory,
        };

        const injectAllActions = shouldInjectActions(slackContext);
        const customActionServers =
          await this.customActionRegistry.createMcpServerConfig(
            actionSlackCtx,
            injectAllActions
              ? undefined
              : action => action.alwaysInject === true,
          );
        options.mcpServers = {
          ...(options.mcpServers || {}),
          ...customActionServers,
        };
      } catch (error) {
        this.logger.error("Failed to create custom MCP tool servers", {
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
        userId: slackContext?.user,
        botId: slackContext?.botId,
        workflowId: slackContext?.workflowId,
        role,
      });
    } else if (slackContext?.user) {
      role = await UserUtils.getUserRole(slackContext.user);
      this.logger.debug("User role determined", {
        userId: slackContext.user,
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
      // The SDK's built-in general-purpose agent is what the model spawns
      // automatically for ad-hoc delegation, and it has no turn limit by
      // default — a runaway general-purpose subagent can loop indefinitely.
      // Override it with a cap so its own loop is bounded. Config-defined
      // subagents (config/subagents/*.yaml) are left untouched.
      "general-purpose": {
        maxTurns: 100,
      },
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

    // Once the SDK yields a terminal limit result (budget/turns), the run is
    // over — we want to deliver whatever the agent produced so far, not retry.
    // The SDK raises after yielding that result; we swallow that raise so the
    // stream ends cleanly and the caller (message-processor) can reply with
    // the partial content plus the limit note from processResultMessage.
    let hitTerminalLimit = false;
    try {
      for await (const message of generator) {
        // Watch for capacity signals so ops is alerted when Opus is falling
        // back to Sonnet. Only meaningful when this request actually targeted
        // Opus as its primary model.
        if (isOpusRequest) {
          this.opusHealthMonitor.observe(message);
        }
        if (message.type === "system" && message.subtype === "init") {
          if (session) {
            session.sessionId = message.session_id;
          }
        }
        if (
          message.type === "result" &&
          (message.subtype === "error_max_budget_usd" ||
            message.subtype === "error_max_turns")
        ) {
          hitTerminalLimit = true;
          this.logger.warn("Query hit terminal limit", {
            subtype: message.subtype,
            errors: (message as any).errors,
            sessionId: session?.sessionId,
          });
        }
        yield message;
      }
    } catch (error) {
      // The SDK raises after yielding the terminal limit result. We've already
      // delivered it to the caller, so treat this as a clean end rather than a
      // retryable failure — otherwise the user gets a generic error instead of
      // the partial response + limit note.
      if (hitTerminalLimit) return;

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
        destroyThreadWorkspace(key);
      }
    }
  }
}
