import { App } from "@slack/bolt";
import { Logger } from "./logger";
import {
  TRACKING_FIELD_MAX_LENGTH,
  CHANNEL_PRIVACY_CACHE_TTL_MS,
} from "./constants";
import { config } from "./config";
import { HttpEventHandler } from "./http-event-handler";
import {
  EventHandler,
  MessageProcessedEvent,
  FeedbackEvent,
  generateMessageId,
  truncateText,
} from "./tracking-types";

// Re-export types and utilities so existing callers don't need to change imports
export {
  EventHandler,
  MessageProcessedEvent,
  FeedbackEvent,
  generateMessageId,
  truncateText,
};

// Logger instance for tracking module
const logger = new Logger("Tracking");

// Slack App reference (set during init)
let slackApp: App | null = null;

// Cache for channel privacy lookups
const channelPrivacyCache = new Map<
  string,
  { isPrivate: boolean; fetchedAt: number }
>();

/** Initialize tracking with Slack App for channel privacy checks */
export const initTracking = (app: App): void => {
  slackApp = app;
};

/** Check if full content logging is allowed (public channel or allowlisted) */
export const isFullContentLoggingAllowed = async (
  channelId: string,
  channelType?: string,
): Promise<boolean> => {
  if (!channelId) return false;
  if (channelType === "im") return false; // DMs = private
  if (!slackApp) {
    logger.warn(
      "Tracking module not initialized - call initTracking() first. Defaulting to private.",
    );
    return false;
  }

  // Check cache
  const cached = channelPrivacyCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CHANNEL_PRIVACY_CACHE_TTL_MS) {
    return !cached.isPrivate;
  }

  // Query Slack API
  try {
    const result = await slackApp.client.conversations.info({
      channel: channelId,
    });
    // Default to private (safe) unless is_private is explicitly false
    const isPrivate = result.channel?.is_private !== false;
    channelPrivacyCache.set(channelId, { isPrivate, fetchedAt: Date.now() });
    return !isPrivate;
  } catch {
    return false; // Default to private on error
  }
};

// ─── ConsoleEventHandler ────────────────────────────────────────────────────

/** Default handler that logs events to the console. */
export class ConsoleEventHandler implements EventHandler {
  async onMessageProcessed(params: MessageProcessedEvent): Promise<void> {
    logger.info("Message processed:", {
      link: params.slackMessageLink,
      user: params.slackUsername,
      ms: params.latencyMs,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      toolCalls: params.toolCalls?.length ?? 0,
    });

    logger.debug(
      "Message processed - Question/Answer content:",
      JSON.stringify(
        {
          question: truncateText(
            params.slackBotQuestion,
            TRACKING_FIELD_MAX_LENGTH,
          ),
          answer: truncateText(
            params.slackBotAnswer,
            TRACKING_FIELD_MAX_LENGTH,
          ),
          messageLink: params.slackMessageLink,
          username: params.slackUsername,
        },
        null,
        2,
      ),
    );
  }

  async onFeedback(params: FeedbackEvent): Promise<void> {
    logger.info(`Feedback ${params.upvoteStatus}:`, {
      link: params.slackMessageLink,
      user: params.slackUsername,
    });

    if (params.slackBotQuestion || params.slackBotAnswer) {
      logger.debug(
        "Message feedback - Question/Answer content:",
        JSON.stringify(
          {
            question: params.slackBotQuestion
              ? truncateText(params.slackBotQuestion, TRACKING_FIELD_MAX_LENGTH)
              : undefined,
            answer: params.slackBotAnswer
              ? truncateText(params.slackBotAnswer, TRACKING_FIELD_MAX_LENGTH)
              : undefined,
            messageLink: params.slackMessageLink,
            username: params.slackUsername,
            upvoteStatus: params.upvoteStatus,
          },
          null,
          2,
        ),
      );
    }
  }
}

// ─── Active handler instance ────────────────────────────────────────────────

const trackingEndpointUrl = process.env.TRACKING_ENDPOINT_URL;
if (trackingEndpointUrl) {
  logger.info("Tracking endpoint configured");
}

const activeHandler: EventHandler = trackingEndpointUrl
  ? new HttpEventHandler(
      new ConsoleEventHandler(),
      trackingEndpointUrl,
      isFullContentLoggingAllowed,
    )
  : new ConsoleEventHandler();

// ─── Public tracking API (unchanged signatures) ─────────────────────────────

/** Track a slack_ai_bot_message_processed event */
export const trackMessageProcessed = async (
  params: MessageProcessedEvent,
): Promise<void> => {
  await activeHandler.onMessageProcessed(params);
};

/** Track a slack_ai_bot_message_feedback event */
export const trackMessageFeedback = async (
  params: FeedbackEvent,
): Promise<void> => {
  await activeHandler.onFeedback(params);
};

/** Helper to generate slack message link */
export const generateSlackMessageLink = (
  channelId: string,
  messageTs: string,
): string => {
  return `${config.slackWorkspaceUrl}/archives/${channelId}/p${messageTs.replace(
    ".",
    "",
  )}`;
};
