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
  FeedbackEvent,
  truncateText,
} from "./tracking-types";

const mockedPost = axios.post as jest.Mock;

// Base handler that does nothing — we only care about the HTTP payload.
const noopBase: EventHandler = {
  onMessageProcessed: jest.fn(),
  onFeedback: jest.fn(),
};

/** Extract the `attributes` object from the most recent tracking POST. */
const lastPostedAttributes = (): Record<string, unknown> => {
  const calls = mockedPost.mock.calls;
  const [, body] = calls[calls.length - 1];
  return (body as { attributes: Record<string, unknown> }[])[0].attributes;
};

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
