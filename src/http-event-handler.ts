import axios from "axios";
import { config } from "./config";
import { SlackChannelType } from "./types";
import { Logger } from "./logger";
import { TRACKING_FIELD_MAX_LENGTH } from "./constants";
import {
  EventHandler,
  MessageProcessedEvent,
  FeedbackEvent,
  truncateText,
} from "./tracking-types";
import { UserUtils } from "./user-utils";

const logger = new Logger("Tracking");

// ─── Internal types for the HTTP event format ───────────────────────────────

type EventType =
  | "slack_ai_bot_message_processed"
  | "slack_ai_bot_message_feedback";

type Properties = Record<
  string,
  boolean | null | number | string | string[] | undefined
> & {
  distinct_id?: number;
};

interface TrackingPayload {
  attributes: Properties;
  client: { client_id: string };
  event_timestamp: number;
  event_type: EventType;
}

// ─── HttpEventHandler ───────────────────────────────────────────────────────

/** Handler that delegates to a base handler and also POSTs events to an HTTP endpoint. */
export class HttpEventHandler implements EventHandler {
  constructor(
    private base: EventHandler,
    private endpointUrl: string,
    private checkContentLogging: (
      channelId: string,
      channelType: SlackChannelType,
    ) => Promise<boolean>,
  ) {}

  /**
   * Merge tracking properties with `distinct_id`, otherwise `0`.
   */
  private async buildAttributesWithDistinctId(
    params: { slackUserId?: string },
    properties: Properties,
  ): Promise<Properties> {
    const distinctId = params.slackUserId
      ? await UserUtils.getUserIdBySlackId(params.slackUserId)
      : null;
    return {
      ...properties,
      distinct_id: distinctId ?? 0,
    };
  }

  async onMessageProcessed(params: MessageProcessedEvent): Promise<void> {
    await this.base.onMessageProcessed(params);

    const includeContent = await this.checkContentLogging(
      params.slackChannel,
      params.slackChannelType,
    );

    const properties: Properties = {
      slack_username: params.slackUsername,
      slack_handle: params.slackHandle,
      slack_channel: params.slackChannel,
      slack_channel_name: params.slackChannelName,
      slack_thread_ts: params.slackThreadTs,
      slack_message_link: params.slackMessageLink,
      slack_bot_question_length: params.slackAppQuestion.length,
      slack_bot_answer_length: params.slackAppAnswer.length,
      // Public channels get the full formatted tool calls (name + params);
      // DMs and private channels get names only, mirroring how we log things.
      slack_bot_tool_calls: includeContent
        ? params.toolCalls
        : params.toolCallNames,
      slack_bot_tool_calls_count: params.toolCalls
        ? params.toolCalls.length
        : 0,
      latency_ms: params.latencyMs,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cache_read_input_tokens: params.cacheReadInputTokens,
      cache_creation_input_tokens: params.cacheCreationInputTokens,
      turn_count: params.turnCount,
    };

    // Serialize phase timings as an array of "name:duration_ms" strings to
    // match the slack_bot_tool_calls pattern. Nested objects aren't supported
    // by the event schema. Skip total_ms since it duplicates latency_ms.
    if (params.phaseTimings) {
      const entries = Object.entries(params.phaseTimings)
        .filter(([key]) => key !== "total_ms")
        .map(([key, value]) => `${key}:${value}`);
      if (entries.length > 0) {
        properties.phase_timings = entries;
      }
    }

    if (includeContent) {
      properties.slack_bot_question = truncateText(
        params.slackAppQuestion,
        TRACKING_FIELD_MAX_LENGTH,
      );
      properties.slack_bot_answer = truncateText(
        params.slackAppAnswer,
        TRACKING_FIELD_MAX_LENGTH,
      );
    }

    const attributes = await this.buildAttributesWithDistinctId(
      params,
      properties,
    );

    const payload: TrackingPayload = {
      attributes,
      client: { client_id: config.trackingClientId },
      event_timestamp: Date.now(),
      event_type: "slack_ai_bot_message_processed",
    };

    await this.sendEvent(payload);
  }

  async onFeedback(params: FeedbackEvent): Promise<void> {
    await this.base.onFeedback(params);

    const properties: Properties = {
      slack_username: params.slackUsername,
      slack_handle: params.slackHandle,
      slack_channel: params.slackChannel,
      slack_channel_name: params.slackChannelName,
      slack_thread_ts: params.slackThreadTs,
      slack_message_link: params.slackMessageLink,
      upvote_status: params.upvoteStatus,
      upvote_target_type: params.upvoteTargetType,
    };

    const attributes = await this.buildAttributesWithDistinctId(
      params,
      properties,
    );

    const payload: TrackingPayload = {
      attributes,
      client: { client_id: config.trackingClientId },
      event_timestamp: Date.now(),
      event_type: "slack_ai_bot_message_feedback",
    };

    await this.sendEvent(payload);
  }

  private async sendEvent(payload: TrackingPayload): Promise<void> {
    try {
      await axios.post(this.endpointUrl, [payload]);
      logger.debug("Event sent to tracking endpoint");
    } catch (error) {
      logger.error("Failed to send tracking event:", error);
    }
  }
}
