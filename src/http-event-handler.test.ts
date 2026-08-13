jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ data: {} }) },
}));

jest.mock("./config", () => ({
  config: { trackingClientId: "test-client", debug: false },
}));

jest.mock("./user-utils", () => ({
  ...jest.requireActual("./user-utils"),
  UserUtils: {
    getUserIdBySlackId: jest.fn().mockResolvedValue(null),
  },
}));

import axios from "axios";
import { HttpEventHandler } from "./http-event-handler";
import {
  EventHandler,
  MessageProcessedEvent,
  MessageClassificationEvent,
  FeedbackEvent,
  truncateText,
} from "./tracking-types";

const mockedPost = axios.post as jest.Mock;

// Base handler that does nothing — we only care about the HTTP payload.
const noopBase: EventHandler = {
  onMessageProcessed: jest.fn(),
  onMessageClassification: jest.fn(),
  onFeedback: jest.fn(),
};

/** Extract the `attributes` object from the most recent tracking POST. */
const lastPostedPayload = (): {
  attributes: Record<string, unknown>;
  event_type: string;
} => {
  const calls = mockedPost.mock.calls;
  const [, body] = calls[calls.length - 1];
  const payload = (
    body as { attributes: Record<string, unknown>; event_type: string }[]
  )[0];
  return payload;
};

const lastPostedAttributes = (): Record<string, unknown> =>
  lastPostedPayload().attributes;

const messageEvent: MessageProcessedEvent = {
  slackUsername: "test-user",
  slackChannel: "C_PUBLIC",
  slackChannelType: "channel",
  slackChannelName: "public-channel",
  slackMessageLink: "https://test.slack.com/archives/C_PUBLIC/p123",
  slackAppQuestion: "question",
  slackAppAnswer: "answer",
  latencyMs: 10,
};

const feedbackEvent: FeedbackEvent = {
  slackUsername: "test-user",
  slackChannel: "C_PUBLIC",
  slackChannelType: "channel",
  slackChannelName: "public-channel",
  slackMessageLink: "https://test.slack.com/archives/C_PUBLIC/p123",
  upvoteStatus: "upvote",
  upvoteTargetType: "slack_ai_bot",
};

const privateOverrides = {
  slackChannel: "C_PRIVATE",
  slackChannelType: "group" as const,
  slackChannelName: "secret-channel",
};

describe("HttpEventHandler channel name privacy", () => {
  beforeEach(() => {
    mockedPost.mockClear();
  });

  it("sends the real channel name when content logging is allowed", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => true,
    );
    await handler.onMessageProcessed(messageEvent);
    expect(lastPostedAttributes().slack_channel_name).toBe("public-channel");
  });

  it("redacts the channel name when content logging is not allowed", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => false,
    );
    await handler.onMessageProcessed({ ...messageEvent, ...privateOverrides });
    expect(lastPostedAttributes().slack_channel_name).toBe("private-channel");
  });

  it("also redacts the channel name for feedback events", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => false,
    );
    await handler.onFeedback({ ...feedbackEvent, ...privateOverrides });
    expect(lastPostedAttributes().slack_channel_name).toBe("private-channel");
  });
});

describe("HttpEventHandler slack_bot_tool_calls length", () => {
  beforeEach(() => {
    mockedPost.mockClear();
  });

  it("truncates individual tool call entries to fit the 256-char Redshift column", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => true,
    );
    const shortCall = "mcp__glean__search(query=test)";
    const longCall = `mcp__example__long_call(prompt=${"x".repeat(300)})`;

    await handler.onMessageProcessed({
      ...messageEvent,
      toolCalls: [shortCall, longCall],
    });

    expect(lastPostedAttributes().slack_bot_tool_calls).toEqual([
      shortCall,
      truncateText(longCall, 256),
    ]);
  });
});

describe("HttpEventHandler agent could help tracking", () => {
  beforeEach(() => {
    mockedPost.mockClear();
  });

  it("emits agent_could_help false when the agent chose DO_NOT_RESPOND", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => true,
    );
    await handler.onMessageProcessed({
      ...messageEvent,
      slackAppAnswer: "",
      agentCouldHelp: false,
      costUsd: 0.012,
    });

    expect(lastPostedAttributes().agent_could_help).toBe(false);
    expect(lastPostedAttributes().cost_usd).toBe(0.012);
  });

  it("emits agent_could_help true for normal replies", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => true,
    );
    await handler.onMessageProcessed({
      ...messageEvent,
      agentCouldHelp: true,
    });

    expect(lastPostedAttributes().agent_could_help).toBe(true);
  });

  it("emits is_smart_reply when the turn was a proactive smart reply", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => true,
    );
    await handler.onMessageProcessed({
      ...messageEvent,
      isSmartReply: true,
    });

    expect(lastPostedAttributes().is_smart_reply).toBe(true);
  });
});

describe("HttpEventHandler message classification tracking", () => {
  const classificationEvent: MessageClassificationEvent = {
    slackUsername: "test-user",
    slackChannel: "C_PUBLIC",
    slackChannelType: "channel",
    slackChannelName: "public-channel",
    slackMessageLink: "https://test.slack.com/archives/C_PUBLIC/p123",
    slackAppQuestion: "how do I deploy?",
    latencyMs: 42,
    costUsd: 0.00008,
    couldHelp: true,
  };

  beforeEach(() => {
    mockedPost.mockClear();
  });

  it("emits slack_ai_bot_message_classification with cost and YES decision", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => true,
    );
    await handler.onMessageClassification(classificationEvent);

    expect(lastPostedPayload().event_type).toBe(
      "slack_ai_bot_message_classification",
    );
    expect(lastPostedAttributes().cost_usd).toBe(0.00008);
    expect(lastPostedAttributes().smart_reply_classifier_could_help).toBe(true);
    expect(lastPostedAttributes().latency_ms).toBe(42);
  });

  it("emits NO decision and cost for classifier rejections", async () => {
    const handler = new HttpEventHandler(
      noopBase,
      "https://track",
      async () => true,
    );
    await handler.onMessageClassification({
      ...classificationEvent,
      couldHelp: false,
      costUsd: 0.00006,
    });

    expect(lastPostedAttributes().smart_reply_classifier_could_help).toBe(
      false,
    );
    expect(lastPostedAttributes().cost_usd).toBe(0.00006);
  });
});
