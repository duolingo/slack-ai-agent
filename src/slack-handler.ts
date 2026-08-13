import { App } from "@slack/bolt";
import { ClaudeHandler } from "./claude-handler";
import { FileHandler, ProcessedFile } from "./file-handler";
import { Logger, withMessageId, truncateForLog } from "./logger";
import { config } from "./config";
import { ChannelConfigManager } from "./channel-config";
import {
  ReactionManager,
  REACTIONS,
  MODE_TRIGGER_EMOJIS,
} from "./reaction-manager";
import { MessageProcessor } from "./message-processor";
import { ButtonMetadataStore } from "./button-metadata";
import { splitMessageForSlack } from "./message-splitter";
import { resolveMode } from "./request-mode";
import {
  passesSmartReplyStructuralFilter,
  classifySmartReplyCandidate,
} from "./smart-reply-filter";
import {
  MessageEvent,
  SlackChannelType,
  SlackContext,
  ConversationSession,
  PhaseTimings,
} from "./types";
import {
  trackMessageProcessed,
  trackMessageFeedback,
  trackMessageClassification,
  generateSlackMessageLink,
  generateMessageId,
  isFullContentLoggingAllowed,
} from "./tracking";
import { UserUtils, redactChannelName } from "./user-utils";
import {
  CONTEXT_CACHE_TTL_MS,
  INCOMING_MESSAGE_LOG_MAX_LENGTH,
  RESPONSE_LOG_MAX_LENGTH,
  SKIPPABLE_EPHEMERAL_ERRORS,
} from "./constants";
import * as fs from "fs";
import * as path from "path";

interface ThreadData {
  context: string | null;
  userText?: string;
}

// Slackbot (reminders, workspace notices) posts under this fixed user ID with
// no bot_id or bot_message subtype, so bot_id checks alone miss it.
const SLACKBOT_USER_ID = "USLACKBOT";

/** True when a message was authored by a bot, a workflow, or Slackbot. */
const isBotAuthoredMessage = (msg: {
  bot_id?: string;
  subtype?: string;
  user?: string;
}): boolean =>
  !!msg.bot_id ||
  msg.subtype === "bot_message" ||
  msg.user === SLACKBOT_USER_ID;

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger("SlackHandler");
  private fileHandler: FileHandler;
  private channelConfig: ChannelConfigManager;
  private reactionManager: ReactionManager;
  private messageProcessor: MessageProcessor;
  private botUserId: string | null = null;

  private buttonMetadata: ButtonMetadataStore;

  // Caching
  private contextCache: Map<string, { text: string; fetchedAt: number }> =
    new Map();

  // Maps a conversation session (user+channel+thread) to the ts of the newest
  // message we've started handling for it. A newer message in the same thread
  // supersedes older in-flight handling so the bot answers the whole thread in
  // one reply instead of replying to each message. See claimLatestSessionMessage.
  private latestSessionMessageTs: Map<string, string> = new Map();

  // Messages folded into the current coalescing window for a session, oldest
  // first. When a follow-up supersedes an in-flight message we don't throw the
  // earlier message away — its text is accumulated here so the single reply
  // treats every message as one combined question rather than answering only
  // the latest with the rest as background. Each entry also remembers whether
  // that message @-mentioned the bot, so the one coalesced reply stays public
  // in-thread when any folded message tagged the bot. See
  // claimLatestSessionMessage / getCoalescedQuery / windowHasExplicitMention.
  private coalescedSessionMessages: Map<
    string,
    { ts: string; text: string; explicitMention: boolean }[]
  > = new Map();

  constructor(
    app: App,
    claudeHandler: ClaudeHandler,
    reactionManager: ReactionManager,
    channelConfig: ChannelConfigManager,
  ) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.fileHandler = new FileHandler(app);
    this.channelConfig = channelConfig;
    this.reactionManager = reactionManager;
    this.messageProcessor = new MessageProcessor(
      claudeHandler,
      this.reactionManager,
      this.channelConfig,
    );
    this.buttonMetadata = new ButtonMetadataStore();
    this.buttonMetadata.startCleanup();
  }

  /**
   * Extract voting data from blocks
   */
  private extractVotingData(blocks: any[]): any | null {
    if (!Array.isArray(blocks)) return null;

    for (const block of blocks) {
      if (block.type === "actions" && Array.isArray(block.elements)) {
        const voteButton = block.elements.find(
          (el: any) => el.action_id === "vote_up",
        );
        if (voteButton?.value) {
          try {
            const parsed = JSON.parse(voteButton.value);
            if (parsed?.ref) {
              const metadata = this.buttonMetadata.lookup(parsed.ref);
              if (!metadata) return null;
              return {
                channel: metadata.channel,
                channel_type: metadata.channelType,
                root_ts: metadata.rootTs,
                question: metadata.question,
                answer: metadata.answer,
              };
            }
            return parsed;
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Check if a message will be sent as ephemeral
   */
  private async checkWillBeEphemeral(
    channel: string,
    explicitMention: boolean,
  ): Promise<boolean> {
    const isEphemeralChannel =
      await this.channelConfig.shouldUseEphemeralMessaging(channel);
    return (
      isEphemeralChannel &&
      !explicitMention &&
      (await this.channelConfig.getEphemeralTargetUsers(channel)).length > 0
    );
  }

  /**
   * Check if reactions should be shown for this message (no reactions for ephemeral messages)
   */
  async shouldShowReactions(event: MessageEvent): Promise<boolean> {
    // Smart-reply turns stay invisible until the bot actually posts a reply, so
    // it never leaves a stray reaction on a message it decided to skip.
    if (event.smartReply) return false;
    return !(await this.checkWillBeEphemeral(
      event.channel,
      !!event.explicitMention,
    ));
  }

  /**
   * Copy original message and response to target channels
   */
  private async copyMessageToChannels(
    targetChannels: string[],
    originalChannelId: string,
    originalMessage: string,
    responseText: string,
    originalMessageTs: string,
    threadTs?: string,
  ): Promise<any[]> {
    const copyResults = [];

    for (const targetChannel of targetChannels) {
      try {
        this.logger.debug(`Copying message thread to channel ${targetChannel}`);

        const originalMessageLink = generateSlackMessageLink(
          originalChannelId,
          originalMessageTs,
        );

        const originalMessageResult = await this.app.client.chat.postMessage({
          channel: targetChannel,
          text: `<${originalMessageLink}|Original message> from <#${originalChannelId}>:\n${originalMessage}`,
        });

        if (!originalMessageResult.ok) {
          copyResults.push({
            ok: false,
            channel: targetChannel,
            error: "Failed to post original message",
          });
          continue;
        }

        const responseResult = await this.sendChunkedWithVoting(
          targetChannel,
          `*AI Response:*\n${responseText}`,
          originalMessageResult.ts,
          {
            channel: targetChannel,
            root_ts: threadTs || originalMessageTs,
            question: originalMessage,
            answer: responseText,
          },
          opts => this.app.client.chat.postMessage(opts),
        );

        copyResults.push(
          responseResult?.ok
            ? {
                ok: true,
                channel: targetChannel,
                responseTs: responseResult.ts,
                originalTs: originalMessageResult.ts,
              }
            : {
                ok: false,
                channel: targetChannel,
                error: "Failed to post response",
              },
        );
      } catch (error) {
        this.logger.error(
          `Error copying message to channel ${targetChannel}:`,
          error,
        );
        copyResults.push({ ok: false, channel: targetChannel, error });
      }
    }

    return copyResults;
  }

  /**
   * Send a message either normally or ephemerally based on channel configuration
   */
  async sendMessage(
    channelId: string,
    channelType: SlackChannelType,
    messageOptions: any,
    fallbackSay?: any,
    isBotMentioned?: boolean,
    originalMessage?: string,
    originalMessageTs?: string,
    replyBroadcast?: boolean,
  ): Promise<any> {
    // If bot is mentioned in an ephemeral channel, send normal public message
    if (
      (await this.channelConfig.shouldUseEphemeralMessaging(channelId)) &&
      !isBotMentioned
    ) {
      const targetUsers =
        await this.channelConfig.getEphemeralTargetUsers(channelId);
      const targetChannels =
        await this.channelConfig.getEphemeralTargetChannels(channelId);

      // Post to target channels first (if any)
      if (targetChannels.length > 0 && originalMessage && originalMessageTs) {
        this.logger.info(
          `Posting to ${
            targetChannels.length
          } target channel(s) first: [${targetChannels.join(", ")}]`,
        );

        const channelCopyResults = await this.copyMessageToChannels(
          targetChannels,
          channelId,
          originalMessage,
          messageOptions.text || "",
          originalMessageTs,
          messageOptions.thread_ts,
        );

        const channelSuccessCount = channelCopyResults.filter(r => r.ok).length;
        this.logger.info("Messages posted to target channels:", {
          totalChannels: targetChannels.length,
          channelSuccessCount,
          channelFailedCount: targetChannels.length - channelSuccessCount,
        });
      }

      // Step 2: Send ephemeral messages to users (if any) with link to channel post
      let ephemeralFailed = false;
      if (targetUsers.length > 0) {
        this.logger.info(
          `Sending ephemeral messages to ${
            targetUsers.length
          } user(s) from ${channelId}${
            messageOptions.thread_ts ? " (threaded)" : " (main channel)"
          }: users=[${targetUsers.join(", ")}]`,
        );
        this.logger.debug("Ephemeral message options:", {
          channel: channelId,
          users: targetUsers,
          hasText: !!messageOptions.text,
          hasBlocks: !!messageOptions.blocks,
          hasThreadTs: !!messageOptions.thread_ts,
          textPreview:
            messageOptions.text?.substring(0, 100) +
            (messageOptions.text?.length > 100 ? "..." : ""),
        });
        try {
          const ephemeralText = messageOptions.text;

          const votingData = messageOptions.blocks
            ? this.extractVotingData(messageOptions.blocks)
            : null;

          // Chunk by Slack's text limit — button values now use server-side
          // refs so they no longer constrain the chunk size.
          const messageChunks = splitMessageForSlack(ephemeralText);

          if (messageChunks.length > 1) {
            this.logger.info(
              `Split ephemeral message into ${messageChunks.length} chunks (${ephemeralText.length} chars)`,
            );
          }

          // Send ephemeral messages (one per chunk) to each user
          const results = [];
          let skippedCount = 0;
          for (const user of targetUsers) {
            let userSkipped = false;
            for (let i = 0; i < messageChunks.length; i++) {
              const chunk = messageChunks[i];

              const chunkBlocks: any[] = this.buildTextAndImageBlocks(chunk);

              // Store full metadata server-side; button value is just a ref.
              const ref = this.buttonMetadata.save({
                channel: channelId,
                channelType: channelType,
                threadTs: messageOptions.thread_ts,
                text: chunk,
                question: votingData?.question,
                rootTs: votingData?.root_ts,
              });
              const refValue = JSON.stringify({ ref });

              chunkBlocks.push({
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "📢 Post to Channel",
                      emoji: true,
                    },
                    action_id: "post_to_channel",
                    value: refValue,
                  },
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "🗑️ Delete",
                      emoji: true,
                    },
                    action_id: "delete_ephemeral",
                    style: "danger",
                    value: refValue,
                  },
                ],
              });

              const ephemeralOptions: any = {
                channel: channelId,
                text: chunk,
                thread_ts: messageOptions.thread_ts,
                unfurl_links: messageOptions.unfurl_links,
                unfurl_media: messageOptions.unfurl_media,
                blocks: chunkBlocks,
                user,
              };
              try {
                const result =
                  await this.app.client.chat.postEphemeral(ephemeralOptions);
                results.push(result);
              } catch (userError: any) {
                const slackError = userError?.data?.error;
                if (SKIPPABLE_EPHEMERAL_ERRORS.has(slackError)) {
                  skippedCount++;
                  this.logger.warn(
                    `Skipping ephemeral message for user ${user}: ${slackError}`,
                  );
                  userSkipped = true;
                  break;
                }
                throw userError;
              }
            }
            if (userSkipped) {
              continue;
            }

            // Send DM notification for ephemeral messages based on channel/user rules
            // Only send once per user, not per chunk
            const shouldSendDM = await this.channelConfig.shouldSendDM(
              channelId,
              user,
            );

            if (shouldSendDM) {
              this.logger.info(
                `Sending DM notification to ${user} for ephemeral message`,
              );

              try {
                // Open DM channel with the user
                const dmChannel = await this.app.client.conversations.open({
                  users: user,
                });

                if (dmChannel.ok && dmChannel.channel?.id) {
                  // Get channel name for context (uses cached lookup)
                  const resolvedName = await this.channelConfig.getChannelName(
                    channelId,
                    channelType,
                  );
                  const channelName = resolvedName
                    ? `#${resolvedName}`
                    : channelId;

                  const threadLink = messageOptions.thread_ts
                    ? generateSlackMessageLink(
                        channelId,
                        messageOptions.thread_ts,
                      )
                    : `${config.slackWorkspaceUrl}/archives/${channelId}`;

                  // Send DM notification
                  await this.app.client.chat.postMessage({
                    channel: dmChannel.channel.id,
                    text: `You received a private AI response in ${channelName} (Note: Click "Reply in thread" to see)`,
                    blocks: [
                      {
                        type: "section",
                        text: {
                          type: "mrkdwn",
                          text: `You received a private AI response in ${channelName} (Note: Click "Reply in thread" to see)`,
                        },
                        accessory: {
                          type: "button",
                          text: {
                            type: "plain_text",
                            text: "📍 View Channel",
                            emoji: true,
                          },
                          url: threadLink,
                          action_id: "view_channel",
                        },
                      },
                    ],
                  });

                  this.logger.info(
                    `DM notification sent successfully to ${user}`,
                  );
                }
              } catch (error) {
                this.logger.error(
                  `Failed to send DM notification to ${user}:`,
                  error,
                );
              }
            }
          }

          const successCount = results.filter(r => r.ok).length;

          this.logger.info("Ephemeral messages sent:", {
            totalUsers: targetUsers.length,
            totalChunks: messageChunks.length,
            successCount,
            skippedCount,
            failedCount: results.length - successCount,
            originalTextLength: ephemeralText.length,
          });

          if (results.length === 0) {
            this.logger.warn(
              `All ${targetUsers.length} ephemeral recipients were skipped, falling back to regular messaging`,
            );
            ephemeralFailed = true;
          } else {
            // Return the first successful result, or the first result if none succeeded
            return results.find(r => r.ok) || results[0];
          }
        } catch (error) {
          this.logger.error(
            "Ephemeral message failed, falling back to regular message:",
            error,
          );
          ephemeralFailed = true;
        }
      }

      // Return success if channels or ephemeral messages were sent successfully
      // Don't return early if ephemeral failed — fall through to regular messaging
      if (
        targetChannels.length > 0 ||
        (targetUsers.length > 0 && !ephemeralFailed)
      ) {
        return { ok: true };
      }
    }

    // Fall back to regular messaging
    this.logger.debug(`Sending regular message to channel ${channelId}`);

    // Add reply_broadcast if requested (posts to thread AND channel)
    if (replyBroadcast && messageOptions.thread_ts) {
      messageOptions.reply_broadcast = true;
    }

    if (fallbackSay) {
      return await fallbackSay(messageOptions);
    } else {
      return await this.app.client.chat.postMessage({
        channel: channelId,
        ...messageOptions,
      });
    }
  }

  /**
   * Main message handler
   */
  async handleMessage(event: MessageEvent, say: any): Promise<void> {
    const startTime = Date.now();
    const messageId = generateMessageId(event.channel, event.ts);

    // Wrap entire handling with messageId context for automatic log correlation
    return withMessageId(messageId, async () => {
      try {
        const timings: PhaseTimings = {};
        let phaseStart = startTime;

        // Log incoming message with compact format and tracking link
        const incomingMessageLink = generateSlackMessageLink(
          event.channel,
          event.ts,
        );
        const allowFullLogging = await isFullContentLoggingAllowed(
          event.channel,
          event.channel_type,
        );
        timings.content_logging_check_ms = Date.now() - phaseStart;
        phaseStart = Date.now();

        this.logger.infoSensitive(
          "📥 Incoming:",
          {
            link: incomingMessageLink,
            textLength: (event.text || "").length,
            hasFiles: !!(event.files && event.files.length > 0),
          },
          truncateForLog(event.text, INCOMING_MESSAGE_LOG_MAX_LENGTH),
          allowFullLogging,
        );

        // Early filtering and validation
        if (await this.shouldSkipMessage(event)) {
          return;
        }

        // Check if user is an authorized member (only for human users)
        if (await this.shouldRejectNonMemberRequest(event, say)) {
          return;
        }
        timings.skip_and_auth_checks_ms = Date.now() - phaseStart;
        phaseStart = Date.now();

        const sessionKey = this.claudeHandler.getSessionKey(
          event.user,
          event.channel,
          event.thread_ts || event.ts,
        );
        const reactionKey = `${sessionKey}:${event.ts}`;
        this.reactionManager.registerMessage(
          reactionKey,
          event.channel,
          event.ts,
        );

        // Fold rapid thread follow-ups into a single reply: mark this as the
        // newest message for the conversation, accumulate its text into the
        // coalescing window, and cancel any in-flight handling of an earlier
        // message in the same thread. A stale (older/out-of-order) delivery
        // bails here — the newest message answers the whole thread, and the
        // earlier messages' text is already folded into its combined query.
        if (
          !this.claimLatestSessionMessage(
            sessionKey,
            event.ts,
            event.text,
            !!event.explicitMention,
          )
        ) {
          this.logger.info(
            "Skipping message superseded by a newer thread reply",
            {
              messageId,
              link: generateSlackMessageLink(event.channel, event.ts),
            },
          );
          return;
        }

        // This run will answer every message folded into the burst, so an
        // @-mention on any of them makes the whole run explicitly mentioned.
        // Upgrade the event in place (callers pass a fresh per-message object)
        // so every downstream consumer — mode resolution, prompt context,
        // action injection, reactions, and delivery — agrees on it. A
        // single-message window resolves to the event's own flag, so nothing
        // changes there.
        if (
          !event.explicitMention &&
          this.windowHasExplicitMention(sessionKey)
        ) {
          event.explicitMention = true;
        }

        // Handle special cases
        if (await this.handleSpecialCommands(event, say)) {
          return;
        }

        // Compute once — used by both the multi-participant gate and
        // processWithClaude (for SlackContext.isNonEphemeralConditionalChannel)
        const isNonEphemeralConditional =
          await this.channelConfig.isNonEphemeralConditionalChannel(
            event.channel,
            event.channel_type,
          );
        timings.conditional_channel_check_ms = Date.now() - phaseStart;
        phaseStart = Date.now();

        // Check thread participation rules
        if (await this.shouldSkipDueToMultipleParticipants(event)) {
          return;
        }
        timings.participant_check_ms = Date.now() - phaseStart;
        phaseStart = Date.now();

        // Process files
        const processedFiles = await this.processFiles(event, reactionKey);
        timings.file_processing_ms = Date.now() - phaseStart;

        // Exit if no content to process
        if (!event.text && processedFiles.length === 0) {
          return;
        }

        // A newer thread message may have arrived while we prepared this one.
        // Bail before spending a model call — the newer message answers the
        // whole thread.
        if (!this.isLatestSessionMessage(sessionKey, event.ts)) {
          return await this.finishSuperseded(
            event,
            processedFiles,
            reactionKey,
          );
        }

        // Get or create session
        const session = await this.getOrCreateSession(event);

        // Set up abort controller
        this.setupAbortController(sessionKey);
        const abortController = this.activeControllers.get(sessionKey)!;

        // Process with Claude
        const result = await this.processWithClaude(
          event,
          session,
          processedFiles,
          abortController,
          reactionKey,
          allowFullLogging,
          isNonEphemeralConditional,
          timings,
        );

        // If a newer thread message superseded us while we were thinking, let
        // it post the combined reply instead of adding a second, redundant one.
        if (!this.isLatestSessionMessage(sessionKey, event.ts)) {
          return await this.finishSuperseded(
            event,
            processedFiles,
            reactionKey,
          );
        }

        // Send response
        await this.sendResponse(
          event,
          result,
          say,
          startTime,
          reactionKey,
          timings,
        );

        // Cleanup
        await this.cleanup(processedFiles, sessionKey, reactionKey);
        this.releaseLatestSessionMessage(sessionKey, event.ts);

        // Log final response with timing, token usage, and tracking link
        const duration = Date.now() - startTime;
        const fullResponse =
          result.messages && result.messages.length > 0
            ? result.messages.join("\n\n")
            : "";
        const finalMessageLink = generateSlackMessageLink(
          event.channel,
          event.ts,
        );
        const responseLog: Record<string, unknown> = {
          link: finalMessageLink,
          msgs: result.messages.length,
          ms: duration,
          responseLength: fullResponse.length,
          toolCalls: result.toolCalls?.length || 0,
        };
        if (result.tokenUsage) {
          responseLog.inputTokens = result.tokenUsage.inputTokens;
          responseLog.outputTokens = result.tokenUsage.outputTokens;
          if (result.tokenUsage.cacheReadInputTokens !== undefined) {
            responseLog.cacheReadTokens =
              result.tokenUsage.cacheReadInputTokens;
          }
          if (result.tokenUsage.cacheCreationInputTokens !== undefined) {
            responseLog.cacheCreationTokens =
              result.tokenUsage.cacheCreationInputTokens;
          }
        }
        if (result.costUsd !== undefined) {
          responseLog.costUsd = result.costUsd;
        }
        this.logger.infoSensitive(
          "📤 Response:",
          responseLog,
          truncateForLog(fullResponse, RESPONSE_LOG_MAX_LENGTH),
          allowFullLogging,
        );

        this.logger.info("⏱️ Phase timings:", timings);

        return;
      } catch (error: any) {
        return await this.handleError(error, event, say);
      }
    });
  }

  /**
   * Check if user should be rejected for not being an authorized member
   */
  private async shouldRejectNonMemberRequest(
    event: MessageEvent,
    say: any,
  ): Promise<boolean> {
    // Skip validation for bot messages
    if (isBotAuthoredMessage(event)) {
      return false;
    }

    // Check if user is an authorized member
    const role = await UserUtils.getUserRole(event.user);

    if (role === "none") {
      const isDM = this.channelConfig.isDirectMessage(event.channel_type);
      const isExplicitMention = !!event.explicitMention;

      // For public channels, responding to non-members can create a lot of
      // noise. So we only tell them when they explicitly DM or tag the bot.
      if (!isDM && !isExplicitMention) {
        this.logger.debug(
          "Ignoring non-member message (no DM/explicit mention)",
          {
            userId: event.user,
            channel: event.channel,
            message: generateSlackMessageLink(event.channel, event.ts),
          },
        );
        return true; // Skip processing silently
      }

      // Send rejection message
      await this.sendMessage(
        event.channel,
        event.channel_type,
        {
          text: "Sorry, this bot is only available to authorized users.",
          thread_ts: event.thread_ts || event.ts,
          unfurl_links: false,
          unfurl_media: false,
        },
        say,
        event.explicitMention,
      );

      this.logger.info("Rejected non-member user request", {
        userId: event.user,
        channel: event.channel,
      });

      return this.markSkipped(event);
    }

    return false; // Continue processing
  }

  /**
   * Check if message should be skipped
   */
  private async shouldSkipMessage(event: MessageEvent): Promise<boolean> {
    // Skip bot messages unless explicitly mentioned or channel allows bot messages
    if (isBotAuthoredMessage(event)) {
      if (event.explicitMention) return false;

      const channelName = await this.channelConfig.getChannelName(
        event.channel,
        event.channel_type,
      );
      const combinedText = this.getCombinedText(
        event.text,
        event.blocks,
        (event as any).attachments,
      );
      const channelConfig =
        await this.channelConfig.findMatchingConditionalChannel(
          channelName,
          combinedText || undefined,
        );
      if (channelConfig?.allowBotMessages) return false;

      return this.markSkipped(event);
    }

    // Skip messages with special emojis or PSA
    if (event.text && this.containsSpecialMarkers(event.text)) {
      return this.markSkipped(event);
    }

    return false;
  }

  /**
   * Check for special markers in message text
   */
  private containsSpecialMarkers(text: string): boolean {
    // Check config-driven suppression emojis (e.g. :shushing_face:, :shhh:)
    const hasSuppressEmoji = REACTIONS.SUPPRESSION_EMOJIS.some(emoji =>
      text.includes(emoji),
    );

    return (
      hasSuppressEmoji ||
      /\bpsa\b/i.test(text) ||
      /(?<!\.)\bfyi\b/i.test(text) || // exclude .fyi URLs (e.g. something.fyi)
      /heads[- ]up/i.test(text)
    );
  }

  /**
   * Handle special commands like cache reload, PR creation, etc.
   */
  private async handleSpecialCommands(
    event: MessageEvent,
    say: any,
  ): Promise<boolean> {
    if (!event.text) return false;

    const text = event.text.trim();

    // Cache reload command
    if (text.toLowerCase() === "cache reload") {
      // Reload channel configuration (channels.yaml)
      this.channelConfig.reloadConfiguration();

      // Reload context files for this channel
      const refreshed = await this.getChannelContext(
        event.channel,
        event.channel_type,
        true,
      );

      const reloadMessage =
        "✅ **Cache reloaded successfully**\n" +
        "• Channel configuration (channels.yaml) reloaded\n" +
        "• Context files refreshed\n\n" +
        "**Current context for this channel:**\n" +
        (refreshed ||
          "(No special context configured for this channel or context empty)");

      await this.sendMessage(
        event.channel,
        event.channel_type,
        {
          text: reloadMessage,
          thread_ts: event.thread_ts || event.ts,
        },
        say,
        event.explicitMention,
      );
      return true;
    }

    return false;
  }

  /**
   * Check if message should be skipped due to multiple human participants
   */
  private async shouldSkipDueToMultipleParticipants(
    event: MessageEvent,
  ): Promise<boolean> {
    // Bot messages that reach here already passed shouldSkipMessage()
    // (via explicitMention or allowBotMessages) — don't block them.
    if (event.explicitMention || isBotAuthoredMessage(event)) {
      return false;
    }
    // Smart-reply turns aren't gated by participant count: if someone asks a
    // question the bot can answer, it should try to help even in a busy channel.
    // The classifier + final "help or stay silent" check already keep it quiet
    // when it can't add value.
    if (event.smartReply) {
      return false;
    }
    return this.hasTwoOrMoreHumanParticipants(
      event.channel,
      event.thread_ts || event.ts,
    );
  }

  /**
   * Decide whether to proactively reply to a message the bot wasn't mentioned
   * in, using layered filtering to keep cost/noise down:
   *   1. Normalize the event; hand off to app_mention if it was actually a mention.
   *   2. Free structural checks (bot/marker skip, length).
   *   3. Cheap Haiku classifier — "could the bot help with this?".
   * Only if all layers pass does it invoke the full pipeline with `smartReply`
   * set, where Claude still gets a final "help or stay silent" contract.
   * Note: unlike mention/conditional flows, smart reply intentionally does NOT
   * gate on participant count — a question the bot can answer should be answered
   * even in a busy channel (see shouldSkipDueToMultipleParticipants).
   */
  private async handleSmartReplyCandidate(
    message: MessageEvent,
    channelName: string | undefined,
    say: any,
  ): Promise<void> {
    // Correlate every smart-reply log line (including the Haiku classifier's)
    // with the same message identifier used elsewhere, and log a clickable
    // Slack link so a skipped candidate can be traced back to the message.
    const messageId = generateMessageId(message.channel, message.ts);
    const link = generateSlackMessageLink(message.channel, message.ts);
    return withMessageId(messageId, async () => {
      try {
        const { event } = await this.prepareEventForHandling(
          message,
          channelName,
        );

        // Explicit mentions are handled by the app_mention listener — don't
        // double-handle (which would post two replies).
        if (event.explicitMention) {
          this.logger.debug("Smart reply: deferring to app_mention (mention)", {
            link,
          });
          return;
        }

        // Free structural filters (Layer 1). shouldSkipMessage drops bot posts
        // and suppression markers.
        if (await this.shouldSkipMessage(event)) {
          this.logger.info("🤖 Smart reply skipped: message filtered", {
            link,
          });
          return;
        }
        if (!passesSmartReplyStructuralFilter(event.text)) {
          this.logger.info("🤖 Smart reply skipped: failed structural filter", {
            link,
            textLength: (event.text || "").length,
          });
          return;
        }

        // Cheap classifier (Layer 2). Only spend a full run when the bot could
        // plausibly help. Every YES/NO decision, latency, and Haiku cost is
        // tracked via slack_ai_bot_message_classification.
        const classifierStart = Date.now();
        const { couldHelp, costUsd: classifierCostUsd } =
          await classifySmartReplyCandidate(event.text || "");
        const classifierLatencyMs = Date.now() - classifierStart;
        this.logger.info("🤖 Smart reply classifier decision", {
          link,
          couldHelp,
          costUsd: classifierCostUsd,
        });
        try {
          await trackMessageClassification({
            slackUserId: event.user,
            slackUsername: await UserUtils.getUsername(this.app, event.user),
            slackHandle: await UserUtils.getSlackHandle(this.app, event.user),
            slackChannel: event.channel,
            slackChannelType: event.channel_type,
            slackChannelName: await this.channelConfig.getChannelName(
              event.channel,
              event.channel_type,
            ),
            slackThreadTs: event.thread_ts,
            slackMessageLink: generateSlackMessageLink(event.channel, event.ts),
            slackAppQuestion: event.text || "",
            latencyMs: classifierLatencyMs,
            costUsd: classifierCostUsd,
            couldHelp,
          });
        } catch (trackingError) {
          this.logger.warn(
            "Failed to track message classification",
            trackingError,
          );
        }
        if (!couldHelp) return;

        await this.handleMessage(
          {
            ...event,
            smartReply: true,
          },
          say,
        );
      } catch (error) {
        this.logger.error("Error in smart reply candidate handling", {
          error,
          link,
        });
      }
    });
  }

  /**
   * Process uploaded files
   */
  private async processFiles(
    event: MessageEvent,
    reactionKey: string,
  ): Promise<ProcessedFile[]> {
    if (!event.files || event.files.length === 0) {
      return [];
    }

    const processedFiles = await this.fileHandler.downloadAndProcessFiles(
      event.files,
    );

    if (processedFiles.length > 0) {
      if (await this.shouldShowReactions(event)) {
        await this.reactionManager.updateReaction(
          reactionKey,
          REACTIONS.THINKING,
        );
      }
    }

    return processedFiles;
  }

  /**
   * Get or create conversation session
   */
  private async getOrCreateSession(
    event: MessageEvent,
  ): Promise<ConversationSession> {
    let session = this.claudeHandler.getSession(
      event.user,
      event.channel,
      event.thread_ts || event.ts,
    );
    if (!session) {
      session = this.claudeHandler.createSession(
        event.user,
        event.channel,
        event.thread_ts || event.ts,
      );
    }
    return session;
  }

  /**
   * Set up abort controller for cancellation
   */
  private setupAbortController(sessionKey: string): void {
    // Cancel any existing request
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);
  }

  /**
   * Process message with Claude
   */
  private async processWithClaude(
    event: MessageEvent,
    session: ConversationSession,
    processedFiles: ProcessedFile[],
    abortController: AbortController,
    reactionKey: string,
    allowFullLogging?: boolean,
    isNonEphemeralConditional?: boolean,
    timings?: PhaseTimings,
  ) {
    const promptStart = Date.now();

    // Fold every question from this coalescing window into one combined query
    // so the single reply answers all of them, not just the latest. The
    // folded messages still appear in the thread context below, so the bot
    // keeps the full picture (including any file references).
    const sessionKey = this.claudeHandler.getSessionKey(
      event.user,
      event.channel,
      event.thread_ts || event.ts,
    );
    const combinedQuery = this.getCoalescedQuery(sessionKey);

    // A coalesced burst must not resume. Each superseded sibling already
    // resumed this session and appended its own (growing) copy of the
    // questions as a user turn before being aborted, so resuming here would
    // replay the same questions across several turns — the model reads the
    // earlier ones as already-handled and answers only the newest. Start fresh
    // instead: the combined query plus the thread context below carry the full
    // history, so the single reply addresses every folded question.
    if (combinedQuery) {
      session.sessionId = undefined;
    }

    const threadData = await this.getThreadData(event);

    // Prepare final prompt and system prompt separately
    const { userPrompt, systemPrompt } = await this.prepareFinalPrompt(
      event,
      processedFiles,
      threadData,
      combinedQuery,
    );
    if (timings) {
      timings.prompt_assembly_ms = Date.now() - promptStart;
    }

    // Set up Slack context
    const slackContext: SlackContext = {
      channel: event.channel,
      channelType: event.channel_type,
      threadTs: event.thread_ts,
      user: event.user,
      botId: event.bot_id,
      workflowId: event.workflow_id,
      messageTs: event.ts,
      messageText: event.text,
      threadUserText: threadData.userText,
      explicitMention: event.explicitMention,
      replyBroadcast: event.replyBroadcast,
      isNonEphemeralConditionalChannel: isNonEphemeralConditional ?? false,
      smartReply: event.smartReply ?? false,
      reactionKey: (await this.shouldShowReactions(event))
        ? reactionKey
        : undefined,
    };

    // Message triggers in event.text override the channel-level default.
    const channelMode = await this.channelConfig.getChannelModelOverride(
      event.channel,
      event.channel_type,
    );
    const requestMode = resolveMode(
      event.text,
      channelMode,
      !!event.explicitMention,
      MODE_TRIGGER_EMOJIS,
    );

    // Process with Claude via MessageProcessor
    const claudeStart = Date.now();
    const result = await this.messageProcessor.processClaudeStream(
      userPrompt,
      session,
      abortController,
      slackContext,
      reactionKey,
      systemPrompt,
      allowFullLogging,
      requestMode,
    );
    if (timings) {
      timings.claude_total_ms = Date.now() - claudeStart;
      if (result.phaseTimings) {
        Object.assign(timings, result.phaseTimings);
      }
    }

    return { ...result, requestMode };
  }

  /**
   * Prepare final prompt with context and files, returning separate system and user prompts
   *
   * Prompt structure:
   * 1. REQUEST_ID (for tracking/deduplication)
   * 2. REQUESTER info
   * 3. CHANNEL info (if not DM)
   * 4. Thread Context (if in thread)
   * 5. Uploaded Files (if any files uploaded - images + non-images)
   * 6. User Query (the actual user message)
   */
  private async prepareFinalPrompt(
    event: MessageEvent,
    processedFiles: ProcessedFile[],
    threadData?: ThreadData,
    combinedQuery?: string,
  ): Promise<{ userPrompt: string; systemPrompt: string }> {
    // Build the system prompt from context files
    const generalContext = await this.channelConfig.getGeneralContextForChannel(
      event.channel_type,
      !!event.explicitMention,
      event.text,
      event.smartReply,
    );
    const channelContext = await this.getChannelContext(
      event.channel,
      event.channel_type,
    );

    // Combine general and channel-specific context for system prompt
    let systemPrompt = generalContext;
    if (channelContext) {
      systemPrompt += "\n\n" + channelContext;
    }

    // Build sections for the user prompt
    const sections: string[] = [];

    // 1. REQUEST_ID at the beginning (for tracking/deduplication)
    const requestId = `${event.channel}-${event.ts}`;
    sections.push(`## Request ID:\n${requestId}`);

    // 2. Requester information with Slack handle for employees.yaml lookups
    const slackHandle = await UserUtils.getSlackHandle(this.app, event.user);
    if (slackHandle) {
      sections.push(
        `## Requester:\n<@${event.user}> (slack_handle: ${slackHandle})`,
      );
    } else {
      // Log warning when Slack handle lookup fails - this may impact employees.yaml lookups
      this.logger.warn("Failed to get Slack handle for user", {
        userId: event.user,
        channel: event.channel,
        message: "employees.yaml lookups may fail without slack_handle field",
      });
      sections.push(`## Requester:\n<@${event.user}>`);
    }

    // 3. Channel information (if not a DM)
    const isDM = this.channelConfig.isDirectMessage(event.channel_type);
    if (!isDM) {
      const channelName = await this.channelConfig.getChannelName(
        event.channel,
        event.channel_type,
      );
      if (channelName) {
        sections.push(`## Channel:\n#${channelName} (${event.channel})`);
      } else {
        sections.push(`## Channel:\n${event.channel}`);
      }
    }
    // Include Workflow ID (if message came from a Slack workflow)
    if (event.workflow_id) {
      sections.push(`## Triggered by Workflow ID:\n${event.workflow_id}`);
    }

    // 4. Thread context (if in a thread)
    const threadContext =
      threadData !== undefined
        ? threadData.context
        : await this.getThreadContext(event);
    if (threadContext) {
      sections.push(`## Thread Context:\n${threadContext}`);
    }

    // 5. Uploaded files (all files including images)
    // Claude Code will use its Read tool to analyze images directly
    if (processedFiles.length > 0) {
      const filesContent = this.fileHandler.formatFilesOnly(processedFiles);
      sections.push(`## Uploaded Files:\n${filesContent}`);
    }

    // 6. User query at the end
    // When rapid thread follow-ups were coalesced, combinedQuery holds every
    // folded message's text as one question. Otherwise fall back to this
    // message's text, defaulting to a files prompt when only files were sent.
    const hasFiles = processedFiles.length > 0;
    const userText =
      combinedQuery ||
      event.text ||
      (hasFiles ? "Please analyze the uploaded files." : "");
    sections.push(`## User Query:\n${userText}`);

    const userPrompt = sections.join("\n\n");

    return { userPrompt, systemPrompt };
  }

  /**
   * Get thread conversation context by fetching previous messages in the thread
   * This is a shared method used by SlackHandler and other components
   */
  async getThreadContext(event: MessageEvent | any): Promise<string | null> {
    return (await this.getThreadData(event)).context;
  }

  /** Prior human-user text and formatted context from the current thread. */
  async getThreadData(event: MessageEvent | any): Promise<ThreadData> {
    const messages = await this.fetchThreadReplies(event);
    if (!messages) {
      return { context: null };
    }

    const context = await this.formatThreadContext(messages, event);
    const userText = this.extractThreadUserText(messages, event);
    return { context, userText };
  }

  private async fetchThreadReplies(
    event: MessageEvent | any,
  ): Promise<any[] | null> {
    if (!event.thread_ts) {
      return null;
    }

    try {
      const resp = await this.app.client.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: 50,
      });

      const messages = (resp.messages as any[]) || [];
      if (messages.length <= 1) {
        return null;
      }

      return messages;
    } catch (error) {
      this.logger.warn("Failed to fetch thread context", {
        channel: event.channel,
        thread_ts: event.thread_ts,
        error,
      });
      return null;
    }
  }

  private async formatThreadContext(
    messages: any[],
    event: MessageEvent | any,
  ): Promise<string | null> {
    const previousMessages = messages.filter(msg => msg.ts !== event.ts);
    const contextLines: string[] = [];

    for (const msg of previousMessages) {
      if (!msg.text && !msg.files && !msg.blocks && !msg.attachments) {
        continue;
      }

      let userDisplay = `<@${msg.user}>`;
      if (msg.user) {
        const userHandle = await UserUtils.getSlackHandle(this.app, msg.user);
        if (userHandle) {
          userDisplay = userHandle;
        }
      } else if (msg.bot_id) {
        userDisplay = `Bot (${msg.bot_id})`;
      }

      let messageText = this.getCombinedText(
        msg.text,
        msg.blocks,
        msg.attachments,
      );

      if (msg.files && msg.files.length > 0) {
        const fileNames = msg.files
          .map((f: any) => f.name || "unknown file")
          .join(", ");
        messageText = messageText
          ? `${messageText} [Files: ${fileNames}]`
          : `[Files: ${fileNames}]`;
      }

      if (messageText.trim()) {
        messageText = this.cleanSlackFormatting(messageText);
        contextLines.push(`**${userDisplay}**: ${messageText}`);
      }
    }

    if (contextLines.length === 0) {
      return null;
    }

    return contextLines.join("\n\n");
  }

  private extractThreadUserText(
    messages: any[],
    event: MessageEvent | any,
  ): string | undefined {
    const texts: string[] = [];

    for (const msg of messages) {
      if (msg.ts === event.ts) continue;
      if (!msg.user || msg.bot_id) continue;

      const messageText = this.getCombinedText(
        msg.text,
        msg.blocks,
        msg.attachments,
      );
      if (messageText.trim()) {
        texts.push(this.cleanSlackFormatting(messageText));
      }
    }

    if (texts.length === 0) {
      return undefined;
    }

    return texts.join("\n");
  }

  /**
   * Clean up Slack formatting for better readability in Claude context
   */
  private cleanSlackFormatting(text: string): string {
    return (
      text
        // Convert user mentions to readable format
        .replace(/<@(\w+)>/g, "@$1")
        // Convert channel mentions to readable format
        .replace(/<#(\w+)\|([^>]+)>/g, "#$2")
        // Convert links to readable format
        .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
        .replace(/<(https?:\/\/[^>]+)>/g, "$1")
        // Clean up extra whitespace
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  /**
   * Create voting buttons block for AI responses
   */
  private createVotingButtonsBlock(data: {
    channel: string;
    channel_type?: SlackChannelType;
    root_ts?: string;
    question?: string;
    answer?: string;
    message_text?: string;
    thread_ts?: string;
    original_question?: string;
    original_answer?: string;
    original_root_ts?: string;
    chunk_ts?: string[];
  }): any {
    const ref = this.buttonMetadata.save({
      channel: data.channel,
      channelType: data.channel_type,
      rootTs: data.root_ts,
      question: data.question,
      answer: data.answer,
      messageText: data.message_text,
      threadTs: data.thread_ts,
      originalQuestion: data.original_question,
      originalAnswer: data.original_answer,
      originalRootTs: data.original_root_ts,
      chunkTs: data.chunk_ts,
    });
    const value = JSON.stringify({ ref });
    return {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "👍 Good", emoji: true },
          action_id: "vote_up",
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "👌 Ok", emoji: true },
          action_id: "vote_ok",
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "👎 Bad", emoji: true },
          action_id: "vote_down",
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🗑️ Delete", emoji: true },
          action_id: "delete_message",
          style: "danger",
          value,
        },
      ],
    };
  }

  /**
   * Split text into Slack-sized chunks, post them sequentially, and attach
   * voting buttons to the last chunk. Returns the final post result.
   */
  private async sendChunkedWithVoting(
    channel: string,
    text: string,
    threadTs: string | undefined,
    votingData: {
      channel: string;
      channel_type?: SlackChannelType;
      root_ts?: string;
      question?: string;
      answer?: string;
    },
    poster: (opts: any) => Promise<any>,
  ): Promise<any> {
    const chunks = splitMessageForSlack(text);
    let result: any;
    const priorChunkTimestamps: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1;
      const chunk = chunks[i];

      const blocks: any[] = this.buildTextAndImageBlocks(chunk);
      if (isLastChunk) {
        blocks.push(
          this.createVotingButtonsBlock({
            ...votingData,
            chunk_ts:
              priorChunkTimestamps.length > 0
                ? [...priorChunkTimestamps]
                : undefined,
          }),
        );
      }

      result = await poster({
        channel,
        text: chunk,
        thread_ts: threadTs,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      });

      if (!isLastChunk) {
        // Collect the timestamp of this non-last chunk so the delete handler
        // can remove every part of a split reply.
        if (result?.ts) {
          priorChunkTimestamps.push(result.ts);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return result;
  }

  /**
   * Send response based on processing result
   */
  private async sendResponse(
    event: MessageEvent,
    result: any,
    say: any,
    startTime?: number,
    reactionKey?: string,
    phaseTimings?: PhaseTimings,
  ): Promise<void> {
    if (!reactionKey) {
      reactionKey = this.getReactionKey(event);
    }

    const willBeEphemeral = await this.checkWillBeEphemeral(
      event.channel,
      !!event.explicitMention,
    );

    if (result.messages.length > 0 && !result.shouldNotRespond) {
      const consolidatedMessage = result.messages.join("\n\n");
      const formatted = this.formatMessage(consolidatedMessage);
      const threadTs = event.thread_ts || event.ts;
      const votingData = {
        channel: event.channel,
        channel_type: event.channel_type,
        root_ts: threadTs,
        question: event.text || "",
        answer: consolidatedMessage,
      };

      const postStart = Date.now();
      if (willBeEphemeral) {
        // Send the full message unsplit — the ephemeral handler does its own chunking
        const messageOptions: any = {
          text: formatted,
          thread_ts: threadTs,
          blocks: [
            ...this.buildTextAndImageBlocks(formatted),
            this.createVotingButtonsBlock(votingData),
          ],
          unfurl_links: false,
          unfurl_media: false,
        };

        await this.sendMessage(
          event.channel,
          event.channel_type,
          messageOptions,
          say,
          event.explicitMention,
          event.text || "",
          event.ts,
          event.replyBroadcast,
        );
      } else {
        await this.sendChunkedWithVoting(
          event.channel,
          formatted,
          threadTs,
          votingData,
          opts =>
            this.sendMessage(
              event.channel,
              event.channel_type,
              opts,
              say,
              event.explicitMention,
              event.text || "",
              event.ts,
              event.replyBroadcast,
            ),
        );
      }

      if (phaseTimings) {
        phaseTimings.send_response_ms = Date.now() - postStart;
      }
    }

    // Track every turn that produced content, even when the post was muted.
    // Also track DO_NOT_RESPOND runs (often no message content) so Opus cost
    // and the agent's silence decision stay visible.
    if (
      result.messages.length > 0 ||
      result.shouldNotRespond ||
      result.doNotRespondOptOut
    ) {
      try {
        const latencyMs = startTime ? Date.now() - startTime : 0;
        if (phaseTimings) phaseTimings.total_ms = latencyMs;
        await trackMessageProcessed({
          slackUserId: event.user,
          slackUsername: await UserUtils.getUsername(this.app, event.user),
          slackHandle: await UserUtils.getSlackHandle(this.app, event.user),
          slackChannel: event.channel,
          slackChannelType: event.channel_type,
          slackChannelName: await this.channelConfig.getChannelName(
            event.channel,
            event.channel_type,
          ),
          slackThreadTs: event.thread_ts,
          slackMessageLink: generateSlackMessageLink(event.channel, event.ts),
          slackAppQuestion: event.text || "",
          slackAppAnswer: result.messages.join("\n\n"),
          latencyMs,
          toolCalls: result.toolCalls,
          toolCallNames: result.toolCallNames,
          inputTokens: result.tokenUsage?.inputTokens,
          outputTokens: result.tokenUsage?.outputTokens,
          cacheReadInputTokens: result.tokenUsage?.cacheReadInputTokens,
          cacheCreationInputTokens: result.tokenUsage?.cacheCreationInputTokens,
          costUsd: result.costUsd,
          turnCount: result.turnCount,
          phaseTimings,
          isOpusFastMode: result.requestMode?.fast ?? false,
          isSmartReply: event.smartReply ?? false,
          agentCouldHelp: !result.doNotRespondOptOut,
        });
      } catch (trackingError) {
        this.logger.warn(
          "Failed to track message processed event",
          trackingError,
        );
      }
    }

    // Update final reaction (skip entirely for ephemeral messages; smart-reply
    // turns never got a reaction to complete).
    if (!willBeEphemeral && !event.smartReply) {
      // Custom actions own their reaction lifecycle end-to-end
      // (waiting-on-human → complete/error, driven by the registry).
      const registryOwnsReaction = result.confirmationDialogPosted === true;
      if (!registryOwnsReaction) {
        const isConditionalSkip =
          result.shouldNotRespond &&
          (await this.channelConfig.isConditionalReplyChannel(
            event.channel,
            event.channel_type,
          ));
        await this.reactionManager.updateReaction(
          reactionKey,
          isConditionalSkip ? REACTIONS.SKIPPED : REACTIONS.COMPLETE,
        );
      }
    }

    // Send debug logs if available
    if (result.debugLogs && result.debugLogs.length > 0) {
      const debugText =
        "Debug logs:\n```\n" + result.debugLogs.join("\n") + "\n```";
      await this.sendMessage(
        event.channel,
        event.channel_type,
        {
          text: debugText,
          thread_ts: event.thread_ts || event.ts,
        },
        say,
        event.explicitMention,
      );
    }
  }

  /**
   * Clean up resources
   */
  private async cleanup(
    processedFiles: ProcessedFile[],
    sessionKey: string,
    reactionKey?: string,
  ): Promise<void> {
    // Clean up temporary files
    if (processedFiles.length > 0) {
      await this.fileHandler.cleanupTempFiles(processedFiles);
    }

    // Clean up controller
    this.activeControllers.delete(sessionKey);

    // Schedule cleanup of reaction tracking. Kept long enough to outlive a
    // pending custom-action dialog: approve/cancel can land hours later and
    // update the original message's reaction through this same session, so it
    // must still be registered when they do.
    const keyToClean = reactionKey || sessionKey;
    setTimeout(
      () => {
        this.reactionManager.cleanupSession(keyToClean);
      },
      12 * 60 * 60 * 1000,
    ); // 12 hours
  }

  /**
   * Handle errors
   */
  private async handleError(
    error: any,
    event: MessageEvent,
    say: any,
    reactionKey?: string,
  ): Promise<void> {
    if (!reactionKey) {
      reactionKey = this.getReactionKey(event);
    }

    if (error.name !== "AbortError") {
      this.logger.error("Error handling message", error);
      if (await this.shouldShowReactions(event)) {
        await this.reactionManager.updateReaction(reactionKey, REACTIONS.ERROR);
      }

      let errorMessage = "❌ Something went wrong";
      if (error?.message?.includes("timed out")) {
        errorMessage = "❌ Request timed out after retries. Please try again.";
      } else if (error?.message?.includes("aborted")) {
        errorMessage = "⏹️ Request was cancelled.";
      } else if (error?.status === 429) {
        errorMessage = "⏳ Rate limit exceeded. Please wait and try again.";
      } else if (error?.status >= 500) {
        errorMessage = "🔧 Server error occurred. Retried but still failed.";
      }

      await this.sendMessage(
        event.channel,
        event.channel_type,
        {
          text: errorMessage,
          thread_ts: event.thread_ts || event.ts,
          unfurl_links: false,
          unfurl_media: false,
        },
        say,
        event.explicitMention,
      );
    } else {
      // An abort almost always means a newer message in the same thread
      // superseded this one (see claimLatestSessionMessage). Mark it skipped
      // rather than errored — the newer message answers the whole thread.
      const sessionKey = this.claudeHandler.getSessionKey(
        event.user,
        event.channel,
        event.thread_ts || event.ts,
      );
      const superseded = !this.isLatestSessionMessage(sessionKey, event.ts);
      this.logger.info(
        superseded
          ? "Request superseded by a newer thread message"
          : "Request was aborted",
        { reactionKey },
      );
      if (await this.shouldShowReactions(event)) {
        await this.reactionManager.updateReaction(
          reactionKey,
          superseded ? REACTIONS.SKIPPED : REACTIONS.ERROR,
        );
      }
    }
  }

  private async getChannelContext(
    channelId: string,
    channelType: SlackChannelType,
    forceRefresh = false,
  ): Promise<string> {
    const filename = await this.channelConfig.getContextSource(
      channelId,
      channelType,
    );
    if (!filename) return "";

    const now = Date.now();

    const cached = this.contextCache.get(filename);
    if (
      cached &&
      !forceRefresh &&
      now - cached.fetchedAt < CONTEXT_CACHE_TTL_MS
    ) {
      return cached.text;
    }

    try {
      const text = fs.readFileSync(
        path.resolve(`config/instructions/${filename}`),
        "utf-8",
      );
      this.contextCache.set(filename, { text, fetchedAt: now });
      this.logger.debug(
        `Loaded channel context from local file for channel ${channelId}: ${filename}`,
      );
      return text;
    } catch (error) {
      this.logger.error(
        `Failed to load channel context for channel ${channelId}`,
        error,
      );
      return cached?.text || "";
    }
  }

  /**
   * Build Block Kit blocks for a text chunk, extracting image URLs and
   * rendering them as native Slack image blocks so they display inline.
   */
  private buildTextAndImageBlocks(text: string): any[] {
    // Match image URLs in two forms:
    // 1. Slack-formatted links: <https://...image.png|alt text> or <https://...image.png>
    // 2. Raw/bare URLs: https://...image.png
    // Both support optional query parameters after the extension.
    const imageUrls: string[] = [];

    // Slack-formatted links: <URL|text> or <URL> — the closing > delimits
    // the URL, so no trailing whitespace/end-of-string check is needed.
    const slackLinkPattern =
      /<(https?:\/\/[^>|]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^>|]*)?)(?:\|[^>]*)?>/gim;
    let match: RegExpExecArray | null;
    while ((match = slackLinkPattern.exec(text)) !== null) {
      imageUrls.push(match[1]);
    }

    // Raw URLs (fallback for cases where links aren't Slack-formatted)
    // Allow trailing punctuation (.,;:!?) before whitespace/end-of-string
    const rawUrlPattern =
      /(?:^|\s)(https?:\/\/[^\s<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s<>]*)?)(?=[.,;:!?)}\]\s]|$)/gim;
    while ((match = rawUrlPattern.exec(text)) !== null) {
      if (!imageUrls.includes(match[1])) {
        imageUrls.push(match[1]);
      }
    }

    const blocks: any[] = [{ type: "section", text: { type: "mrkdwn", text } }];

    // Append an image block for each extracted URL (Slack allows up to 50 blocks)
    for (const url of imageUrls) {
      blocks.push({
        type: "image",
        image_url: url,
        alt_text: "Generated image",
      });
    }

    return blocks;
  }

  private formatMessage(text: string): string {
    return text
      .replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, code) => "```" + code + "```")
      .replace(/`([^`]+)`/g, "`$1`")
      .replace(/\*\*([^*]+)\*\*/g, "*$1*")
      .replace(/__([^_]+)__/g, "_$1_");
  }

  /** Compute a message-specific reaction key (does NOT register the message). */
  private getReactionKey(event: MessageEvent): string {
    const sessionKey = this.claudeHandler.getSessionKey(
      event.user,
      event.channel,
      event.thread_ts || event.ts,
    );
    return `${sessionKey}:${event.ts}`;
  }

  /**
   * Register `ts` as the newest message for its conversation session, fold its
   * text into the coalescing window, and cancel any in-flight handling of an
   * earlier message in the same thread. Returns false when an equal or newer
   * message already owns the session, so this (stale/out-of-order) delivery
   * should be dropped — the newer message answers the thread, and its context
   * already includes this message.
   *
   * The earlier message isn't discarded: its text stays in the window (see
   * getCoalescedQuery) so the single reply answers every folded message as one
   * combined question, not just the latest.
   *
   * Synchronous by design: the read, the write, and the abort happen with no
   * `await` between them, so two concurrent deliveries can't both take the claim.
   */
  private claimLatestSessionMessage(
    sessionKey: string,
    ts: string,
    text?: string,
    explicitMention?: boolean,
  ): boolean {
    const current = this.latestSessionMessageTs.get(sessionKey);
    if (current !== undefined && !this.isNewerTs(ts, current)) {
      return false;
    }
    // A brand-new window starts fresh; a follow-up appends to the running one.
    const window =
      current === undefined ? [] : this.getCoalescedWindow(sessionKey);
    if (!window.some(m => m.ts === ts)) {
      window.push({
        ts,
        text: text ?? "",
        explicitMention: !!explicitMention,
      });
    }
    this.coalescedSessionMessages.set(sessionKey, window);
    this.latestSessionMessageTs.set(sessionKey, ts);
    // Stop the now-superseded run; its reply guards keep it from posting.
    this.activeControllers.get(sessionKey)?.abort();
    return true;
  }

  /** True until a newer message in the same thread supersedes `ts`. */
  private isLatestSessionMessage(sessionKey: string, ts: string): boolean {
    return this.latestSessionMessageTs.get(sessionKey) === ts;
  }

  /** Drop the coalescing marker + window once the latest message is answered. */
  private releaseLatestSessionMessage(sessionKey: string, ts: string): void {
    if (this.latestSessionMessageTs.get(sessionKey) === ts) {
      this.latestSessionMessageTs.delete(sessionKey);
      this.coalescedSessionMessages.delete(sessionKey);
    }
  }

  /** Messages folded into the session's current coalescing window, oldest first. */
  private getCoalescedWindow(
    sessionKey: string,
  ): { ts: string; text: string; explicitMention: boolean }[] {
    return this.coalescedSessionMessages.get(sessionKey) ?? [];
  }

  /**
   * True when any message folded into the session's coalescing window
   * @-mentioned the bot. The burst gets a single reply, so an @-mention on any
   * folded message must make that reply public in-thread — otherwise tagging
   * the bot and then adding a follow-up would silently downgrade the answer to
   * an ephemeral message only the requester can see.
   *
   * For a window holding a single message this is just that message's own
   * explicitMention, so single-message handling is unchanged.
   */
  private windowHasExplicitMention(sessionKey: string): boolean {
    return this.getCoalescedWindow(sessionKey).some(m => m.explicitMention);
  }

  /**
   * Build the combined user query for the winning message from every message
   * folded into its coalescing window (oldest first), so the single reply
   * answers every question in the thread rather than only the latest. Returns
   * undefined when the window holds one question or fewer, so the caller keeps
   * its normal single-message prompt. The folded messages are intentionally
   * left in the thread context too, so nothing (e.g. file references) is lost.
   */
  private getCoalescedQuery(sessionKey: string): string | undefined {
    const texts = this.getCoalescedWindow(sessionKey)
      .map(m => m.text.trim())
      .filter(text => text.length > 0);
    return texts.length > 1 ? texts.join("\n\n") : undefined;
  }

  /** Compare two Slack `seconds.micros` timestamps; true when `a` is newer. */
  private isNewerTs(a: string, b: string): boolean {
    const [aSec, aMicro = "0"] = a.split(".");
    const [bSec, bMicro = "0"] = b.split(".");
    const aSeconds = Number(aSec);
    const bSeconds = Number(bSec);
    if (aSeconds !== bSeconds) return aSeconds > bSeconds;
    return Number(aMicro) > Number(bMicro);
  }

  /**
   * A newer message in the same thread has taken over answering this
   * conversation. Release this message's temp files and clear its in-progress
   * reaction so the bot posts a single combined reply instead of one per
   * message. Deliberately leaves the session's abort controller and coalescing
   * marker alone — those now belong to the newer message.
   */
  private async finishSuperseded(
    event: MessageEvent,
    processedFiles: ProcessedFile[],
    reactionKey: string,
  ): Promise<void> {
    this.logger.info("Folded into a newer thread message; skipping reply", {
      link: generateSlackMessageLink(event.channel, event.ts),
    });
    if (processedFiles.length > 0) {
      await this.fileHandler.cleanupTempFiles(processedFiles);
    }
    // A message that @-mentioned the bot was answered by the combined reply,
    // not skipped — clear any in-progress reaction instead of the SKIPPED one.
    if (event.explicitMention) {
      await this.reactionManager.clearReaction(reactionKey);
    } else if (await this.shouldShowReactions(event)) {
      await this.reactionManager.updateReaction(reactionKey, REACTIONS.SKIPPED);
    }
  }

  /** Register the message for reaction tracking, add SKIPPED reaction, return true. */
  private async markSkipped(event: MessageEvent): Promise<true> {
    const reactionKey = this.getReactionKey(event);
    this.reactionManager.registerMessage(reactionKey, event.channel, event.ts);
    if (await this.shouldShowReactions(event)) {
      await this.reactionManager.updateReaction(reactionKey, REACTIONS.SKIPPED);
    }
    return true;
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error("Failed to get bot user ID", error);
        this.botUserId = "";
      }
    }
    return this.botUserId;
  }

  private async hasTwoOrMoreHumanParticipants(
    channel: string,
    rootTs: string,
  ): Promise<boolean> {
    try {
      const botUserId = await this.getBotUserId();
      const resp = await this.app.client.conversations.replies({
        channel,
        ts: rootTs,
        limit: 200,
      });

      const messages = (resp.messages as any[]) || [];
      const humanUserIds = new Set<string>();

      for (const m of messages) {
        const isBot = isBotAuthoredMessage(m);
        const userId: string | undefined = m.user;
        if (isBot || !userId || (botUserId && userId === botUserId)) continue;

        humanUserIds.add(userId);
        if (humanUserIds.size >= 2) return true;
      }
      return false;
    } catch (error) {
      this.logger.warn("Error checking human participants in thread", {
        channel,
        rootTs,
        error,
      });
      return false;
    }
  }

  // ========== EVENT HANDLERS ==========

  setupEventHandlers() {
    // Handle direct messages and conditional reply channels
    this.app.message(async ({ message, say }: { message: any; say: any }) => {
      const isBotMessage = isBotAuthoredMessage(message);
      if (message.subtype === undefined || isBotMessage) {
        const channelId: string = message.channel;
        const channelType = message.channel_type;
        const isDM = this.channelConfig.isDirectMessage(channelType);

        // Channel-only match for the routing gate — explicit mentions and
        // keyword/pattern filtering are handled by shouldHandleMessage inside
        // prepareEventForHandling, so the gate must not enforce message
        // requirements (otherwise @bot mentions that don't match alert
        // keywords would be silently dropped).
        let channelName: string | undefined;
        let isConditionalChannel = false;
        let conditionalChannel: any = null;
        if (!isDM) {
          channelName = await this.channelConfig.getChannelName(
            channelId,
            channelType,
          );
          isConditionalChannel =
            !!(await this.channelConfig.findMatchingConditionalChannel(
              channelName,
            ));
          if (isConditionalChannel) {
            // Message-aware match to get the correct config for allowBotMessages
            const combinedText = this.getCombinedText(
              message.text,
              message.blocks,
              message.attachments,
            );
            conditionalChannel =
              await this.channelConfig.findMatchingConditionalChannel(
                channelName,
                combinedText || undefined,
              );
          }
        }

        if (isDM || isConditionalChannel) {
          try {
            const { shouldHandle, event: normalizedEvent } =
              await this.prepareEventForHandling(
                { ...message, channel_type: channelType } as MessageEvent,
                channelName,
              );

            // For bot messages, only proceed if channel config allows them OR if explicitly mentioned
            if (
              isBotMessage &&
              !conditionalChannel?.allowBotMessages &&
              !normalizedEvent.explicitMention
            ) {
              return;
            }

            if (shouldHandle) {
              await this.handleMessage(normalizedEvent, say);
            } else {
              const allowFullLogging = await isFullContentLoggingAllowed(
                channelId,
                channelType,
              );
              this.logger.info("Message skipped due to shouldHandle=false", {
                channelId,
                channelName: redactChannelName(
                  channelName,
                  channelType,
                  allowFullLogging,
                ),
                userId: message.user ?? message.bot_id ?? "undefined",
                textPreview: (message.text || "").substring(0, 100),
              });
            }
          } catch (error) {
            this.logger.error("Error in app.message handler", {
              error,
              channelId,
              userId: message.user ?? message.bot_id ?? "undefined",
              textPreview: (message.text || "").substring(0, 100),
            });
          }
        } else if (!isBotMessage && !isDM && !isConditionalChannel) {
          // Proactive smart reply: only consider channels on the include list.
          // Ineligible channels return immediately — no routing log, classifier,
          // or tracking.
          if (
            channelName &&
            (await this.channelConfig.isSmartReplyEligibleChannelName(
              channelName,
              channelType,
            ))
          ) {
            await this.handleSmartReplyCandidate(
              { ...message, channel_type: channelType } as MessageEvent,
              channelName,
              say,
            );
          }
        }
      }
    });

    // Handle app mentions in other channels (excluding conditional pattern channels
    // which are handled by app.message to avoid duplicate responses)
    this.app.event(
      "app_mention",
      async ({ event, say }: { event: any; say: any }) => {
        const channelId = event.channel;
        // app_mention events don't include channel_type in their payload;
        // look it up via conversations.info when missing.
        const channelType: SlackChannelType =
          event.channel_type ??
          (await this.channelConfig.lookupChannelType(channelId));
        const isDM = this.channelConfig.isDirectMessage(channelType);

        // Skip conditional reply channels - they're handled by app.message
        let hasConditionalChannel = false;
        if (!isDM) {
          const channelName = await this.channelConfig.getChannelName(
            channelId,
            channelType,
          );
          hasConditionalChannel =
            !!(await this.channelConfig.findMatchingConditionalChannel(
              channelName,
            ));
        }

        if (!isDM && !hasConditionalChannel) {
          const { shouldHandle, event: normalizedEvent } =
            await this.prepareEventForHandling({
              ...event,
              channel_type: channelType,
            } as MessageEvent);
          if (shouldHandle) {
            await this.handleMessage(normalizedEvent, say);
          }
        }
      },
    );

    // Handle file uploads
    this.app.event(
      "message",
      async ({ event, say }: { event: any; say: any }) => {
        if (event.subtype === "file_share" && "user" in event && event.files) {
          const { shouldHandle, event: normalizedEvent } =
            await this.prepareEventForHandling(event as MessageEvent);
          if (shouldHandle) {
            await this.handleMessage(normalizedEvent, say);
          }
        }
      },
    );

    // Log when bot itself is added to a channel
    this.app.event(
      "member_joined_channel",
      async ({ event }: { event: any }) => {
        const botUserId = await this.getBotUserId();
        if (botUserId && event.user === botUserId) {
          this.logger.info("Bot joined channel", {
            channel: event.channel,
            inviter: event.inviter,
          });
        }
      },
    );

    // Cleanup inactive sessions periodically
    setInterval(
      () => {
        this.claudeHandler.cleanupInactiveSessions();
      },
      10 * 60 * 1000,
    );

    for (const { actionId, label, upvoteStatus } of [
      { actionId: "vote_up", label: "good", upvoteStatus: "upvote" as const },
      {
        actionId: "vote_down",
        label: "bad",
        upvoteStatus: "downvote" as const,
      },
      { actionId: "vote_ok", label: "OK", upvoteStatus: "ok" as const },
    ]) {
      this.app.action(
        actionId,
        async ({ ack, body }: { ack: any; body: any }) => {
          await ack();
          await this.handleVoteAction(body, label, upvoteStatus);
        },
      );
    }

    this.app.action(
      "delete_message",
      async ({ ack, body }: { ack: any; body: any }) => {
        await ack();
        try {
          const action = body?.actions?.[0];
          const parsed = this.parseVotePayload(action);
          const channel = parsed?.channel || body?.container?.channel_id;
          // Default to "im" (most restrictive) to avoid leaking private content in logs/tracking
          const channelType = parsed?.channel_type || "im";
          const ts = body?.container?.message_ts;
          const userId = body?.user?.id;

          // Track delete feedback before deleting the message
          try {
            const slackMessageLink = generateSlackMessageLink(
              channel,
              parsed?.root_ts || ts, // Use original message timestamp for consistency
            );

            await trackMessageFeedback({
              slackUserId: userId,
              slackUsername: await UserUtils.getUsername(this.app, userId),
              slackHandle: userId,
              slackChannel: channel,
              slackChannelType: channelType,
              slackChannelName: await this.channelConfig.getChannelName(
                channel,
                channelType,
              ),
              slackThreadTs: parsed?.root_ts,
              slackMessageLink,
              upvoteStatus: "delete",
              upvoteTargetType: "slack_ai_bot",
              slackAppQuestion: parsed?.question,
              slackAppAnswer: parsed?.answer,
            });
          } catch (trackingError) {
            this.logger.warn("Failed to track delete feedback", trackingError);
          }

          // Delete the bot message (last chunk / only message)
          await this.app.client.chat.delete({
            channel,
            ts,
          });

          // Delete prior chunks of a split reply, if any
          if (parsed?.chunk_ts && Array.isArray(parsed.chunk_ts)) {
            for (const chunkTs of parsed.chunk_ts) {
              try {
                await this.app.client.chat.delete({
                  channel,
                  ts: chunkTs,
                });
              } catch (chunkError) {
                this.logger.warn(
                  `Failed to delete chunk message ${chunkTs}`,
                  chunkError,
                );
              }
            }
          }

          this.logger.info(
            `🗑️ Delete by ${await UserUtils.getUsername(this.app, userId)}`,
            {
              channel: channel,
            },
          );
        } catch (error) {
          this.logger.warn("Failed handling delete_message action", error);
        }
      },
    );

    // Handle "Post to Channel" button from ephemeral messages
    this.app.action(
      "post_to_channel",
      async ({ ack, body }: { ack: any; body: any }) => {
        await ack();
        try {
          const action = body?.actions?.[0];
          const userId = body?.user?.id;

          // Parse the button data — new format uses a server-side ref,
          // legacy format has inline fields.
          let responseData: any = null;
          try {
            responseData = JSON.parse(action?.value || "{}");
          } catch (e) {
            this.logger.warn("Could not parse post_to_channel button data", e);
            return;
          }

          let channel: string;
          let threadTs: string | undefined;
          let votingData: any;
          let messageText: string;

          if (responseData.ref) {
            const metadata = this.buttonMetadata.lookup(responseData.ref);
            if (!metadata) {
              this.logger.warn("Button metadata expired for post_to_channel");
              return;
            }
            channel = metadata.channel;
            threadTs = metadata.threadTs;
            messageText = metadata.text || "";
            votingData = {
              channel_type: metadata.channelType,
              root_ts: metadata.rootTs,
              question: metadata.question,
            };
          } else {
            channel = responseData.channel || body?.container?.channel_id;
            threadTs = responseData.thread_ts;
            votingData = responseData.voting_data;
            messageText = responseData.text || "";
          }

          if (!messageText || !channel) {
            this.logger.warn(
              "Missing message text or channel for post_to_channel action",
              {
                hasText: !!messageText,
                textLength: messageText?.length,
                channel,
              },
            );
            return;
          }

          // Add acceptance note to show who clicked "Post to Channel"
          const messageTextWithAcceptance = `${messageText}\n\n_(Accepted by <@${userId}>)_`;

          // Post the permanent message to the channel, splitting into chunks if needed
          const fullMessageChunks = splitMessageForSlack(
            messageTextWithAcceptance,
          );

          let publicMessage: any;
          const priorPublicChunkTs: string[] = [];
          for (let i = 0; i < fullMessageChunks.length; i++) {
            const isLastChunk = i === fullMessageChunks.length - 1;
            const chunk = fullMessageChunks[i];

            // Reconstruct blocks for each chunk (with inline image blocks)
            const chunkBlocks: any[] = this.buildTextAndImageBlocks(chunk);

            // Only add voting buttons to the last chunk
            if (isLastChunk) {
              chunkBlocks.push(
                this.createVotingButtonsBlock({
                  channel: channel,
                  channel_type: votingData?.channel_type,
                  root_ts: votingData?.root_ts || threadTs || "",
                  question: votingData?.question || "",
                  answer: votingData?.answer || messageText,
                  chunk_ts:
                    priorPublicChunkTs.length > 0
                      ? [...priorPublicChunkTs]
                      : undefined,
                }),
              );
            }

            // Post chunk as regular message to the channel
            publicMessage = await this.app.client.chat.postMessage({
              channel,
              text: chunk,
              thread_ts: threadTs,
              blocks: chunkBlocks,
            });

            if (!isLastChunk && publicMessage?.ts) {
              priorPublicChunkTs.push(publicMessage.ts);
            }

            // Use the first message's timestamp for subsequent chunks
            // Only if there wasn't already a thread_ts set (avoid creating nested threads)
            if (i === 0 && !threadTs && publicMessage.ok && publicMessage.ts) {
              // Continue posting in the thread
              threadTs = publicMessage.ts;
            }
          }

          // Delete the ephemeral message only after successful posting
          if (publicMessage?.ok) {
            await this.deleteEphemeralViaResponseUrl(body?.response_url);
          }
        } catch (error) {
          this.logger.warn("Failed handling post_to_channel action", error);
        }
      },
    );

    // Handle "Delete" button from ephemeral messages
    this.app.action(
      "delete_ephemeral",
      async ({ ack, body }: { ack: any; body: any }) => {
        await ack();
        try {
          const userId = body?.user?.id;
          await this.deleteEphemeralViaResponseUrl(body?.response_url);
          this.logger.info(
            `🗑️ Ephemeral message deleted by ${await UserUtils.getUsername(
              this.app,
              userId,
            )}`,
          );
        } catch (error) {
          this.logger.warn("Failed handling delete_ephemeral action", error);
        }
      },
    );
  }

  private async deleteEphemeralViaResponseUrl(
    responseUrl?: string,
  ): Promise<void> {
    if (!responseUrl) {
      this.logger.warn(
        "No response_url available - cannot delete ephemeral message",
      );
      return;
    }
    try {
      const deleteResponse = await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete_original: true }),
      });
      const responseBody = await deleteResponse.text();
      if (!deleteResponse.ok) {
        this.logger.warn(
          `Failed to delete ephemeral message via response_url: ${deleteResponse.status} ${responseBody}`,
        );
        return;
      }
      this.logger.debug("Ephemeral message deleted via response_url");
    } catch (error) {
      this.logger.warn(
        "Failed to delete ephemeral message via response_url",
        error,
      );
    }
  }

  private async handleVoteAction(
    body: any,
    label: string,
    upvoteStatus: "upvote" | "downvote" | "ok",
  ): Promise<void> {
    try {
      const action = body?.actions?.[0];
      const parsed = this.parseVotePayload(action);
      const channel = parsed?.channel || body?.container?.channel_id;
      // Default to "im" (most restrictive) to avoid leaking private content in logs/tracking
      const channelType = parsed?.channel_type || "im";
      const ts = body?.container?.message_ts;
      const userId = body?.user?.id;

      const newBlocks = (body?.message?.blocks || [])
        .filter((b: any) => b.type !== "actions")
        .concat({
          type: "context",
          elements: [
            { type: "mrkdwn", text: `Message rated ${label} by <@${userId}>` },
          ],
        });

      await this.app.client.chat.update({
        channel,
        ts,
        blocks: newBlocks,
        text: `Message rated ${label}`,
      });

      try {
        const slackMessageLink = generateSlackMessageLink(
          channel,
          parsed?.root_ts || ts,
        );
        await trackMessageFeedback({
          slackUserId: userId,
          slackUsername: await UserUtils.getUsername(this.app, userId),
          slackHandle: userId,
          slackChannel: channel,
          slackChannelType: channelType,
          slackChannelName: await this.channelConfig.getChannelName(
            channel,
            channelType,
          ),
          slackThreadTs: parsed?.root_ts,
          slackMessageLink,
          upvoteStatus,
          upvoteTargetType: "slack_ai_bot",
          slackAppQuestion: parsed?.question,
          slackAppAnswer: parsed?.answer,
        });
        this.logger.info(
          `🗳️ ${label} vote by ${await UserUtils.getUsername(this.app, userId)}`,
          { link: slackMessageLink },
        );
      } catch (trackingError) {
        this.logger.warn(`Failed to track ${label} feedback`, trackingError);
      }
    } catch (error) {
      this.logger.warn(`Failed handling ${upvoteStatus} action`, error);
    }
  }

  private parseVotePayload(action: any): {
    channel?: string;
    channel_type?: SlackChannelType;
    answer_ts?: string;
    root_ts?: string;
    question?: string;
    answer?: string;
    message_text?: string;
    thread_ts?: string;
    original_question?: string;
    original_answer?: string;
    original_root_ts?: string;
    chunk_ts?: string[];
  } | null {
    try {
      if (!action?.value) return null;
      const parsed = JSON.parse(action.value);
      if (typeof parsed !== "object" || parsed === null) return null;
      if (parsed.ref) {
        const metadata = this.buttonMetadata.lookup(parsed.ref);
        // Stale ref (TTL expiry or lost flush) — a bare { ref } gives callers
        // nothing usable, so treat it as unparseable. Log it: callers fall back
        // to the interaction body, so the click still registers and the only
        // outward sign is an earlier chunk of a split reply surviving a delete.
        if (!metadata) {
          this.logger.warn("Button metadata expired", { ref: parsed.ref });
          return null;
        }
        return {
          channel: metadata.channel,
          channel_type: metadata.channelType,
          root_ts: metadata.rootTs,
          question: metadata.question,
          answer: metadata.answer,
          message_text: metadata.messageText,
          thread_ts: metadata.threadTs,
          original_question: metadata.originalQuestion,
          original_answer: metadata.originalAnswer,
          original_root_ts: metadata.originalRootTs,
          chunk_ts: metadata.chunkTs,
        };
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  /**
   * Extract text content from Slack blocks recursively.
   * Handles header, section, rich_text, context, and other block types.
   */
  private getCombinedText(
    text?: string,
    blocks?: any[],
    attachments?: any[],
  ): string {
    // For user-typed messages, rich_text blocks mirror `text`; extracting
    // them duplicates the message everywhere downstream (agent input,
    // ephemeral channel clones). Only read them when there is no plain
    // text to mirror. Content-bearing blocks (section/header/context in
    // bot alerts) are still extracted.
    const contentBlocks = text
      ? blocks?.filter(b => b?.type !== "rich_text")
      : blocks;
    const blockText = this.extractTextFromBlocks(contentBlocks);
    const attachmentText = this.extractTextFromAttachments(attachments);
    return [text, blockText, attachmentText].filter(Boolean).join(" ");
  }

  private extractTextFromAttachments(attachments?: any[]): string {
    if (!attachments || !Array.isArray(attachments)) {
      return "";
    }
    return attachments
      .map(a => [a.text, a.fallback, a.pretext].filter(Boolean).join(" "))
      .filter(Boolean)
      .join(" ");
  }

  private extractTextFromBlocks(blocks?: any[]): string {
    if (!blocks || !Array.isArray(blocks)) {
      return "";
    }

    const textParts: string[] = [];

    const extractFromElement = (element: any): void => {
      if (!element) return;

      // Direct text content
      if (element.text) {
        if (typeof element.text === "string") {
          textParts.push(element.text);
        } else if (element.text.text) {
          textParts.push(element.text.text);
        }
      }

      // Nested elements array (rich_text, context, etc.)
      if (Array.isArray(element.elements)) {
        for (const child of element.elements) {
          extractFromElement(child);
        }
      }

      // Fields array (section blocks)
      if (Array.isArray(element.fields)) {
        for (const field of element.fields) {
          if (field.text) {
            if (typeof field.text === "string") {
              textParts.push(field.text);
            } else if (field.text.text) {
              textParts.push(field.text.text);
            }
          }
        }
      }
    };

    for (const block of blocks) {
      extractFromElement(block);
    }

    return textParts.join(" ");
  }

  /**
   * Normalize message text and explicit mention, and decide if we should handle
   * based on DM/conditional reply/explicit mention rules.
   */
  private async prepareEventForHandling(
    message: MessageEvent,
    providedChannelName?: string,
  ): Promise<{ shouldHandle: boolean; event: MessageEvent }> {
    const channelId = message.channel;
    const isDM = this.channelConfig.isDirectMessage(message.channel_type);

    let text = message.text || "";
    let explicitMention = false;
    let replyBroadcast = false;

    try {
      const botUserId = await this.getBotUserId();
      if (botUserId && typeof text === "string") {
        // Match both <@ID> and the legacy <@ID|label> form — Slackbot
        // reminders and some older integrations embed mentions with a label.
        const botMentionPattern = new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g");
        const stripped = text.replace(botMentionPattern, "");
        if (stripped !== text) {
          explicitMention = true;
          text = stripped.trim();
        }
      }
    } catch (_) {
      // Fail open: leave explicitMention as false and text unchanged
    }

    // Check for :postit: emoji to enable reply_broadcast (post to thread AND channel)
    if (typeof text === "string") {
      const postitPattern = /^(\[DEBUG\]\s*)?:postit:\s*/i;
      if (postitPattern.test(text)) {
        replyBroadcast = true;
        // Remove the :postit: emoji from the text
        text = text.replace(postitPattern, "$1").trim();
      }
    }

    // Use provided channel name or fetch it for conditional reply pattern matching
    let channelName = providedChannelName;
    if (!channelName && !isDM) {
      channelName = await this.channelConfig.getChannelName(
        channelId,
        message.channel_type,
      );
    }

    // Combine message text with block text for conditional pattern matching
    // This handles Slack Block Kit messages where content is in blocks, not text
    const combinedText = this.getCombinedText(
      text,
      message.blocks,
      (message as any).attachments,
    );

    const shouldHandle = await this.channelConfig.shouldHandleMessage(
      isDM,
      explicitMention,
      combinedText,
      channelName,
      message.workflow_id,
    );

    // Debug logging for troubleshooting
    this.logger.debug("prepareEventForHandling", {
      channelId,
      channelName,
      isDM,
      explicitMention,
      replyBroadcast,
      shouldHandle,
      textLength: text.length,
      combinedTextLength: combinedText.length,
      hasText: !!text,
      hasBlocks: !!message.blocks?.length,
    });

    return {
      shouldHandle,
      event: {
        ...message,
        text: text || combinedText,
        explicitMention,
        replyBroadcast,
      },
    };
  }
}
