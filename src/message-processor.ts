import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeHandler } from "./claude-handler";
import { ConversationSession, SlackContext, TokenUsage } from "./types";
import { Logger, truncateForLog } from "./logger";
import { ReactionManager, REACTIONS } from "./reaction-manager";
import { ChannelConfigManager } from "./channel-config";
import {
  TOOL_CALL_PARAM_LOG_MAX_LENGTH,
  TOOL_RESPONSE_LOG_MAX_LENGTH,
} from "./constants";

export interface MessageProcessorResult {
  messages: string[];
  shouldNotRespond: boolean;
  debugLogs?: string[];
  toolCalls?: string[];
  tokenUsage?: TokenUsage;
  turnCount?: number;
}

export class MessageProcessor {
  private logger = new Logger("MessageProcessor");
  private claudeHandler: ClaudeHandler;
  private reactionManager: ReactionManager;
  private channelConfig: ChannelConfigManager;

  constructor(
    claudeHandler: ClaudeHandler,
    reactionManager: ReactionManager,
    channelConfig: ChannelConfigManager,
  ) {
    this.claudeHandler = claudeHandler;
    this.reactionManager = reactionManager;
    this.channelConfig = channelConfig;
  }

  /**
   * Log with privacy handling and optionally add to debug logs for [DEBUG] mode.
   * Server logs respect allowFullLogging; debug logs always show full content + safeData.
   */
  private logSensitive(
    message: string,
    safeData: Record<string, unknown>,
    sensitiveContent: string,
    allowFullLogging: boolean,
    isDebugMode?: boolean,
    debugLogs?: string[],
  ): void {
    this.logger.infoSensitive(
      message,
      safeData,
      sensitiveContent,
      allowFullLogging,
    );
    if (isDebugMode && debugLogs) {
      const safeStr =
        Object.keys(safeData).length > 0 ? ` ${JSON.stringify(safeData)}` : "";
      debugLogs.push(`${message} ${sensitiveContent}${safeStr}`);
    }
  }

  /**
   * Check if reactions should be shown for this message (no reactions for ephemeral messages)
   */
  private async shouldShowReactions(
    slackContext: SlackContext,
  ): Promise<boolean> {
    const isEphemeralChannel =
      await this.channelConfig.shouldUseEphemeralMessaging(
        slackContext.channel,
      );
    const willBeEphemeral =
      isEphemeralChannel &&
      !slackContext.explicitMention &&
      (await this.channelConfig.getEphemeralTargetUsers(slackContext.channel))
        .length > 0;
    return !willBeEphemeral;
  }

  /**
   * Process messages from Claude SDK stream
   */
  async processClaudeStream(
    prompt: string,
    session: ConversationSession,
    abortController: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
    sessionKey?: string,
    systemPrompt?: string,
    allowFullLogging?: boolean,
  ): Promise<MessageProcessorResult> {
    const currentMessages: string[] = [];
    const debugLogs: string[] = [];
    const toolCalls: string[] = [];
    let shouldNotRespond = false;
    let tokenUsage: TokenUsage | undefined;
    let turnCount = 0;

    // Check if debug mode is enabled
    const isDebugMode = prompt.includes("[DEBUG]");

    // Log query start with session info
    this.logger.info("📝 Starting query", {
      promptLen: prompt.length,
      resuming: !!session.sessionId,
      isDebugMode: isDebugMode ? "true" : "false",
    });

    // Start with thinking reaction
    if (
      sessionKey &&
      slackContext &&
      (await this.shouldShowReactions(slackContext))
    ) {
      await this.reactionManager.updateReaction(sessionKey, REACTIONS.THINKING);
    }

    for await (const message of this.claudeHandler.streamQuery(
      prompt,
      session,
      abortController,
      workingDirectory,
      slackContext,
      async () => {},
      systemPrompt,
    )) {
      if (abortController.signal.aborted) {
        this.logger.warn("⏹️ Aborted", { sessionKey });
        break;
      }

      if (message.type === "assistant") {
        // Count each assistant message as a turn in the agentic loop
        turnCount++;

        await this.processAssistantMessage(
          message,
          currentMessages,
          sessionKey,
          slackContext,
          isDebugMode,
          debugLogs,
          toolCalls,
          allowFullLogging,
        );

        // Check for special responses
        const content = this.extractTextContent(message);
        if (
          content &&
          slackContext &&
          (await this.channelConfig.isConditionalReplyChannel(
            slackContext.channel,
            slackContext.channelType,
          ))
        ) {
          if (content.match(/DO_NOT_RESPOND/i)) {
            shouldNotRespond = true;
          }
        }
      } else if (message.type === "user") {
        // Handle tool result messages (user messages with tool_result content)
        this.processToolResultMessage(
          message,
          isDebugMode,
          debugLogs,
          allowFullLogging,
        );
      } else if (message.type === "result") {
        await this.processResultMessage(message, currentMessages);

        // Extract token usage from result message (check both direct and nested locations)
        const usage = (message as any).usage || (message as any).message?.usage;
        if (usage) {
          tokenUsage = {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadInputTokens: usage.cache_read_input_tokens,
            cacheCreationInputTokens: usage.cache_creation_input_tokens,
          };
        }

        // Check for special responses in results too
        const resultText =
          (message as any).result || (message as any).message?.result;
        if (
          resultText &&
          slackContext &&
          (await this.channelConfig.isConditionalReplyChannel(
            slackContext.channel,
            slackContext.channelType,
          ))
        ) {
          if (resultText.match(/DO_NOT_RESPOND/i)) {
            shouldNotRespond = true;
          }
        }
      }
    }

    // Log completion summary with token usage and turn count
    const completionLog: Record<string, unknown> = {
      msgs: currentMessages.length,
      tools: toolCalls.length,
      turns: turnCount,
    };
    if (tokenUsage) {
      completionLog.inputTokens = tokenUsage.inputTokens;
      completionLog.outputTokens = tokenUsage.outputTokens;
      if (tokenUsage.cacheReadInputTokens !== undefined) {
        completionLog.cacheReadTokens = tokenUsage.cacheReadInputTokens;
      }
      if (tokenUsage.cacheCreationInputTokens !== undefined) {
        completionLog.cacheCreationTokens = tokenUsage.cacheCreationInputTokens;
      }
    }
    this.logger.info("✅ Completed", completionLog);

    return {
      messages: currentMessages,
      shouldNotRespond,
      debugLogs: isDebugMode ? debugLogs : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage,
      turnCount: turnCount > 0 ? turnCount : undefined,
    };
  }

  /**
   * Process assistant messages from Claude
   */
  private async processAssistantMessage(
    message: SDKMessage,
    currentMessages: string[],
    sessionKey?: string,
    slackContext?: SlackContext,
    isDebugMode?: boolean,
    debugLogs?: string[],
    toolCallsTracking?: string[],
    allowFullLogging?: boolean,
  ): Promise<void> {
    // Check if this is a tool use message
    const hasToolUse = message.message.content?.some(
      (part: any) => part.type === "tool_use",
    );

    if (hasToolUse) {
      // Get tool names for logging
      const toolCalls =
        message.message.content
          ?.filter((part: any) => part.type === "tool_use")
          .map((part: any) => ({
            name: part.name,
            parameters: part.input || {},
          })) || [];

      const toolNames = toolCalls.map((t: any) => t.name);

      // Format tool call with params
      const formatToolCall = (t: any) => {
        const params = Object.entries(t.parameters ?? {})
          .map(
            ([k, v]) =>
              `${k}=${truncateForLog(typeof v === "string" ? v : JSON.stringify(v), TOOL_CALL_PARAM_LOG_MAX_LENGTH)}`,
          )
          .join(", ");
        return params ? `${t.name}(${params})` : `${t.name}()`;
      };

      const formattedCalls = toolCalls.map(formatToolCall);
      const fullPreview = formattedCalls.join(" | ");

      // Log with privacy handling: tool names are safe, params are sensitive
      this.logSensitive(
        "🔧",
        { tools: toolNames },
        fullPreview,
        allowFullLogging ?? false,
        isDebugMode,
        debugLogs,
      );
      // Track individual tool calls for analytics (preserves correct count)
      if (toolCallsTracking) toolCallsTracking.push(...formattedCalls);

      if (
        sessionKey &&
        slackContext &&
        (await this.shouldShowReactions(slackContext))
      ) {
        await this.reactionManager.updateReaction(
          sessionKey,
          REACTIONS.TOOL_USE,
        );
      }

      // Extract any text content from tool use messages
      const content = this.extractTextContent(message);
      if (content) {
        this.addSubstantialContent(content, currentMessages, "tool use");
      }
    } else {
      // Handle regular text content
      const content = this.extractTextContent(message);
      if (content) {
        this.addSubstantialContent(content, currentMessages, "assistant");
      }
    }
  }

  /**
   * Process result messages from Claude
   */
  private async processResultMessage(
    message: SDKMessage,
    currentMessages: string[],
  ): Promise<void> {
    const messageData = (message as any).message || (message as any);
    const isSuccessfulResult =
      message.subtype === "success" ||
      (message.subtype === "error_during_execution" && !messageData.is_error);

    const resultText = (message as any).result || messageData.result;
    if (isSuccessfulResult && resultText && currentMessages.length === 0) {
      // Only add result if we don't already have text content from assistant messages
      currentMessages.push(resultText);
    }
  }

  /**
   * Process tool result messages (user messages with tool_result content blocks)
   */
  private processToolResultMessage(
    message: SDKMessage,
    isDebugMode?: boolean,
    debugLogs?: string[],
    allowFullLogging?: boolean,
  ): void {
    const content =
      (message as any).message?.content || (message as any).content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === "tool_result") {
        const raw = block.content;
        const resultContent =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw.map((c: any) => c?.text || JSON.stringify(c)).join("")
              : JSON.stringify(raw ?? "");

        const preview = truncateForLog(
          resultContent,
          TOOL_RESPONSE_LOG_MAX_LENGTH,
        );

        // Log with privacy handling: server logs respect allowFullLogging, debug logs show full
        this.logSensitive(
          `📋 Result (${resultContent.length} chars):`,
          {},
          preview,
          allowFullLogging ?? false,
          isDebugMode,
          debugLogs,
        );
      }
    }
  }

  /**
   * Extract text content from Claude message
   */
  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === "assistant" && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text);

      const content = textParts.join("");
      return content || null;
    }
    return null;
  }

  /**
   * Add substantial content to messages array (filtering out intermediate steps)
   */
  private addSubstantialContent(
    content: string,
    messages: string[],
    sourceType: string,
  ): void {
    const minLength = sourceType === "tool use" ? 300 : 500;
    const isSubstantialContent =
      content.length > minLength &&
      (content.includes("##") ||
        content.includes("###") ||
        content.includes("Action Plan"));
    const isIntermediateStep = content.match(/^(Now let me|Let me|I'll)/i);

    if (
      !messages.includes(content) &&
      isSubstantialContent &&
      !isIntermediateStep
    ) {
      messages.push(content);
    }
  }
}
