/**
 * Unit tests for SlackHandler private helper methods.
 *
 * We mock heavy dependencies (config, reaction-manager, channel-config, etc.)
 * so we can test the pure logic in isolation.
 */

// --- Module mocks (must be before imports) ---

jest.mock("./config", () => ({
  config: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "test-secret",
    },
    anthropic: { apiKey: "test-key", model: "claude-opus-5" },
    slackWorkspaceUrl: "https://test.slack.com",
    baseDirectory: "/tmp/test",
    persistDir: "/tmp/test-persist",
    debug: false,
  },
}));

jest.mock("./reaction-manager", () => {
  return {
    REACTIONS: {
      THINKING: "hourglass_flowing_sand",
      TOOL_USE: "gear",
      COMPLETE: "white_check_mark",
      SKIPPED: "see_no_evil",
      WAITING_ON_HUMAN: "raised_hand",
      ERROR: "x",
      SUPPRESSION_EMOJIS: [":shushing_face:", ":shhh:"],
    },
    MODE_TRIGGER_EMOJIS: {},
    ReactionManager: jest.fn().mockImplementation(() => ({
      registerMessage: jest.fn(),
      updateReaction: jest.fn(),
      cleanupSession: jest.fn(),
    })),
  };
});

jest.mock("./channel-config", () => ({
  ChannelConfigManager: jest.fn().mockImplementation(() => ({
    setApp: jest.fn(),
    shouldUseEphemeralMessaging: jest.fn().mockResolvedValue(false),
    getEphemeralTargetUsers: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("./message-processor", () => ({
  MessageProcessor: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("./file-handler", () => ({
  FileHandler: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("./tracking", () => ({
  trackMessageProcessed: jest.fn(),
  trackMessageFeedback: jest.fn(),
  trackMessageClassification: jest.fn(),
  generateSlackMessageLink: jest.fn(
    (ch: string, ts: string) =>
      `https://test.slack.com/archives/${ch}/p${ts.replace(".", "")}`,
  ),
  generateMessageId: jest.fn(() => "test-id"),
  isFullContentLoggingAllowed: jest.fn().mockResolvedValue(true),
}));

jest.mock("./user-utils", () => ({
  UserUtils: {
    getUserRole: jest.fn().mockResolvedValue("member"),
    getUsername: jest.fn().mockResolvedValue("testuser"),
    getSlackHandle: jest.fn().mockResolvedValue("testhandle"),
    startCleanupInterval: jest.fn(),
  },
}));

import { ChannelConfigManager } from "./channel-config";
import { SlackHandler } from "./slack-handler";
import { MessageEvent } from "./types";
import { UserUtils } from "./user-utils";
import { trackMessageProcessed } from "./tracking";

// --- Test helpers ---

interface TestHarness {
  handler: SlackHandler;
  app: any;
  claudeHandler: any;
  reactionManager: any;
  channelConfig: any;
}

function createHandler(): TestHarness {
  const mockApp = {
    client: {
      auth: { test: jest.fn().mockResolvedValue({ user_id: "UBOTID" }) },
      chat: {
        postMessage: jest.fn().mockResolvedValue({ ok: true, ts: "1.1" }),
        postEphemeral: jest.fn().mockResolvedValue({ ok: true }),
        update: jest.fn().mockResolvedValue({ ok: true }),
        delete: jest.fn().mockResolvedValue({ ok: true }),
      },
      conversations: {
        replies: jest.fn().mockResolvedValue({ messages: [] }),
      },
      reactions: {
        add: jest.fn().mockResolvedValue({ ok: true }),
        remove: jest.fn().mockResolvedValue({ ok: true }),
      },
    },
    message: jest.fn(),
    event: jest.fn(),
    action: jest.fn(),
  } as any;

  const mockClaudeHandler = {
    getSessionKey: jest.fn(
      (user: string, channel: string, threadTs: string) =>
        `${user}:${channel}:${threadTs}`,
    ),
    getSession: jest.fn(),
    createSession: jest.fn(),
    cleanupInactiveSessions: jest.fn(),
  } as any;

  const mockReactionManager = {
    registerMessage: jest.fn(),
    updateReaction: jest.fn().mockResolvedValue(undefined),
    clearReaction: jest.fn().mockResolvedValue(undefined),
    cleanupSession: jest.fn(),
  } as any;

  const mockChannelConfig = new (ChannelConfigManager as any)();

  const handler = new SlackHandler(
    mockApp,
    mockClaudeHandler,
    mockReactionManager,
    mockChannelConfig,
  );

  const channelConfig = mockChannelConfig;

  return {
    handler,
    app: mockApp,
    claudeHandler: mockClaudeHandler,
    reactionManager: mockReactionManager,
    channelConfig,
  };
}

/** Access a private method on the handler for testing. */
function priv(handler: SlackHandler): any {
  return handler as any;
}

function makeEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    user: "U123",
    channel: "C456",
    ts: "1234567890.123456",
    channel_type: "channel",
    ...overrides,
  };
}

// --- Tests ---

describe("SlackHandler", () => {
  let t: TestHarness;
  let handler: SlackHandler;

  beforeEach(() => {
    t = createHandler();
    handler = t.handler;
  });

  describe("containsSpecialMarkers", () => {
    const check = (text: string) => priv(handler).containsSpecialMarkers(text);

    it("detects suppression emojis", () => {
      expect(check("please :shushing_face: be quiet")).toBe(true);
      expect(check(":shhh: something")).toBe(true);
    });

    it("detects PSA keyword", () => {
      expect(check("PSA: new policy")).toBe(true);
      expect(check("This is a psa about something")).toBe(true);
    });

    it("detects FYI keyword", () => {
      expect(check("FYI the server is down")).toBe(true);
      expect(check("just fyi")).toBe(true);
    });

    it("does not trigger on .fyi URLs", () => {
      expect(check("check out something.fyi")).toBe(false);
    });

    it("detects heads-up variations", () => {
      expect(check("heads up everyone")).toBe(true);
      expect(check("Heads-up: deploy incoming")).toBe(true);
    });

    it("returns false for normal messages", () => {
      expect(check("hello world")).toBe(false);
      expect(check("can you help me?")).toBe(false);
    });
  });

  describe("formatMessage", () => {
    const fmt = (text: string) => priv(handler).formatMessage(text);

    it("converts **bold** to *bold*", () => {
      expect(fmt("**hello**")).toBe("*hello*");
    });

    it("converts __italic__ to _italic_", () => {
      expect(fmt("__hello__")).toBe("_hello_");
    });

    it("strips language hints from code blocks", () => {
      expect(fmt("```python\nprint('hi')\n```")).toBe("```print('hi')\n```");
    });

    it("preserves inline code", () => {
      expect(fmt("`code`")).toBe("`code`");
    });
  });

  describe("createVotingButtonsBlock", () => {
    it("stores metadata server-side and button value contains only a ref", () => {
      const block = priv(handler).createVotingButtonsBlock({
        channel: "C123",
        root_ts: "1.1",
        question: "x".repeat(5000),
        answer: "y".repeat(5000),
      });
      const value = block.elements[0].value;
      expect(value.length).toBeLessThan(100);
      const parsed = JSON.parse(value);
      expect(parsed.ref).toBeDefined();
      expect(parsed.question).toBeUndefined();
    });

    it("all four buttons share the same ref", () => {
      const block = priv(handler).createVotingButtonsBlock({
        channel: "C123",
        question: "hello",
        answer: "world",
      });
      const refs = block.elements.map((el: any) => JSON.parse(el.value).ref);
      expect(new Set(refs).size).toBe(1);
    });

    it("stored metadata is retrievable via parseVotePayload", () => {
      const block = priv(handler).createVotingButtonsBlock({
        channel: "C123",
        root_ts: "1.1",
        question: "the question",
        answer: "the answer",
        chunk_ts: ["2.2", "3.3"],
      });
      const parsed = priv(handler).parseVotePayload(block.elements[0]);
      expect(parsed?.channel).toBe("C123");
      expect(parsed?.root_ts).toBe("1.1");
      expect(parsed?.question).toBe("the question");
      expect(parsed?.answer).toBe("the answer");
      expect(parsed?.chunk_ts).toEqual(["2.2", "3.3"]);
    });
  });

  describe("cleanSlackFormatting", () => {
    const clean = (text: string) => priv(handler).cleanSlackFormatting(text);

    it("converts user mentions", () => {
      expect(clean("Hello <@U123>")).toBe("Hello @U123");
    });

    it("converts channel mentions", () => {
      expect(clean("See <#C123|general>")).toBe("See #general");
    });

    it("converts labeled links to markdown", () => {
      expect(clean("<https://example.com|Example>")).toBe(
        "[Example](https://example.com)",
      );
    });

    it("unwraps bare links", () => {
      expect(clean("<https://example.com>")).toBe("https://example.com");
    });

    it("collapses whitespace", () => {
      expect(clean("hello   \n  world")).toBe("hello world");
    });
  });

  describe("getCombinedText", () => {
    const combined = (text?: string, blocks?: any[]) =>
      priv(handler).getCombinedText(text, blocks);

    it("returns text when no blocks", () => {
      expect(combined("hello")).toBe("hello");
    });

    it("returns block text when no text", () => {
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: "from block" } },
      ];
      expect(combined(undefined, blocks)).toBe("from block");
    });

    it("combines text and block text", () => {
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: "block" } },
      ];
      expect(combined("text", blocks)).toBe("text block");
    });

    it("handles empty inputs", () => {
      expect(combined()).toBe("");
      expect(combined("", [])).toBe("");
    });

    it("skips rich_text blocks when text is present (they mirror text)", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "hello world" }],
            },
          ],
        },
      ];
      expect(combined("hello world", blocks)).toBe("hello world");
    });

    it("still extracts rich_text blocks when text is empty", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "only in blocks" }],
            },
          ],
        },
      ];
      expect(combined(undefined, blocks)).toBe("only in blocks");
    });

    it("still combines section blocks with text (bot alerts)", () => {
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: "alert detail" } },
      ];
      expect(combined("Urgency: High", blocks)).toBe(
        "Urgency: High alert detail",
      );
    });
  });

  describe("extractTextFromBlocks", () => {
    const extract = (blocks?: any[]) =>
      priv(handler).extractTextFromBlocks(blocks);

    it("returns empty string for null/undefined", () => {
      expect(extract(undefined)).toBe("");
      expect(extract(null as any)).toBe("");
    });

    it("extracts text from section blocks", () => {
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: "hello" } },
      ];
      expect(extract(blocks)).toBe("hello");
    });

    it("extracts text from nested elements (rich_text)", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "nested" }],
            },
          ],
        },
      ];
      expect(extract(blocks)).toBe("nested");
    });

    it("extracts text from fields", () => {
      const blocks = [
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "field1" },
            { type: "mrkdwn", text: "field2" },
          ],
        },
      ];
      expect(extract(blocks)).toBe("field1 field2");
    });

    it("extracts text from header blocks", () => {
      const blocks = [
        { type: "header", text: { type: "plain_text", text: "Title" } },
      ];
      expect(extract(blocks)).toBe("Title");
    });
  });

  describe("getReactionKey", () => {
    it("computes key from event fields", () => {
      const event = makeEvent({
        user: "U1",
        channel: "C2",
        thread_ts: "111.222",
        ts: "333.444",
      });
      const key = priv(handler).getReactionKey(event);
      expect(key).toBe("U1:C2:111.222:333.444");
    });

    it("falls back to ts when thread_ts is absent", () => {
      const event = makeEvent({
        user: "U1",
        channel: "C2",
        ts: "333.444",
      });
      const key = priv(handler).getReactionKey(event);
      expect(key).toBe("U1:C2:333.444:333.444");
    });
  });

  describe("parseVotePayload", () => {
    const parse = (action: any) => priv(handler).parseVotePayload(action);

    it("parses valid JSON value", () => {
      const result = parse({
        value: JSON.stringify({ channel: "C1", root_ts: "1.1" }),
      });
      expect(result).toEqual({ channel: "C1", root_ts: "1.1" });
    });

    it("returns null for missing value", () => {
      expect(parse({})).toBeNull();
      expect(parse(null)).toBeNull();
      expect(parse(undefined)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parse({ value: "not json" })).toBeNull();
    });

    it("returns null for non-object JSON", () => {
      expect(parse({ value: '"just a string"' })).toBeNull();
      expect(parse({ value: "42" })).toBeNull();
    });

    it("preserves channel_type in parsed payload", () => {
      const result = parse({
        value: JSON.stringify({
          channel: "D1",
          channel_type: "im",
          root_ts: "1.1",
        }),
      });
      expect(result).toEqual({
        channel: "D1",
        channel_type: "im",
        root_ts: "1.1",
      });
    });

    it("returns null when the ref is stale (metadata missing)", () => {
      const result = parse({
        value: JSON.stringify({ ref: "nonexistent-ref" }),
      });
      expect(result).toBeNull();
    });
  });

  describe("createVotingButtonsBlock (channel_type)", () => {
    it("preserves channel_type through ref lookup", () => {
      const block = priv(handler).createVotingButtonsBlock({
        channel: "D1",
        channel_type: "im",
        root_ts: "1.1",
        question: "q",
        answer: "a",
      });
      const parsed = priv(handler).parseVotePayload(block.elements[0]);
      expect(parsed?.channel_type).toBe("im");
    });
  });

  // =====================================================================
  // shouldRespond flow tests — needed before refactoring
  // =====================================================================

  describe("shouldSkipMessage", () => {
    beforeEach(() => {
      // Default: no conditional channel config
      t.channelConfig.getChannelName = jest.fn().mockResolvedValue("general");
      t.channelConfig.findMatchingConditionalChannel = jest
        .fn()
        .mockResolvedValue(null);
    });

    it("skips bot messages and marks SKIPPED", async () => {
      const event = makeEvent({ bot_id: "B123", text: "bot says hi" });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(true);
      expect(t.reactionManager.registerMessage).toHaveBeenCalled();
      expect(t.reactionManager.updateReaction).toHaveBeenCalledWith(
        expect.any(String),
        "see_no_evil",
      );
    });

    it("skips bot_message subtype", async () => {
      const event = makeEvent({ subtype: "bot_message", text: "workflow" });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(true);
    });

    it("does NOT skip bot message with explicitMention", async () => {
      const event = makeEvent({
        bot_id: "B123",
        explicitMention: true,
        text: "hello",
      });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(false);
    });

    it("does NOT skip bot message when channel allows bot messages", async () => {
      t.channelConfig.findMatchingConditionalChannel.mockResolvedValue({
        allowBotMessages: true,
      });
      const event = makeEvent({ bot_id: "B123", text: "hello" });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(false);
    });

    it("skips Slackbot messages without explicit mention", async () => {
      const event = makeEvent({ user: "USLACKBOT", text: "Reminder: hi" });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(true);
    });

    it("does NOT skip Slackbot message with explicitMention", async () => {
      const event = makeEvent({
        user: "USLACKBOT",
        explicitMention: true,
        text: "Reminder: hello",
      });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(false);
    });

    it("skips messages with PSA marker", async () => {
      const event = makeEvent({ text: "PSA: new deploy" });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(true);
    });

    it("skips messages with suppression emoji", async () => {
      const event = makeEvent({ text: ":shushing_face: quiet" });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(true);
    });

    it("does NOT skip normal human messages", async () => {
      const event = makeEvent({ text: "help me please" });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(false);
    });

    it("does NOT skip messages without text", async () => {
      const event = makeEvent({ text: undefined });
      const result = await priv(handler).shouldSkipMessage(event);
      expect(result).toBe(false);
    });
  });

  describe("shouldRejectNonMemberRequest", () => {
    const mockSay = jest.fn();

    beforeEach(() => {
      mockSay.mockClear();
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.getEphemeralTargetUsers = jest.fn().mockResolvedValue([]);
      t.channelConfig.getEphemeralTargetChannels = jest
        .fn()
        .mockResolvedValue([]);
      t.channelConfig.isDirectMessage = jest.fn().mockReturnValue(false);
    });

    it("does not reject bot messages", async () => {
      (UserUtils.getUserRole as jest.Mock).mockResolvedValue("none");
      const event = makeEvent({ bot_id: "B123" });
      const result = await priv(handler).shouldRejectNonMemberRequest(
        event,
        mockSay,
      );
      expect(result).toBe(false);
    });

    it("does not reject Slackbot messages", async () => {
      (UserUtils.getUserRole as jest.Mock).mockResolvedValue("none");
      const event = makeEvent({ user: "USLACKBOT", explicitMention: true });
      const result = await priv(handler).shouldRejectNonMemberRequest(
        event,
        mockSay,
      );
      expect(result).toBe(false);
      expect(mockSay).not.toHaveBeenCalled();
    });

    it("does not reject authorized members", async () => {
      (UserUtils.getUserRole as jest.Mock).mockResolvedValue("member");
      const event = makeEvent({ text: "hello" });
      const result = await priv(handler).shouldRejectNonMemberRequest(
        event,
        mockSay,
      );
      expect(result).toBe(false);
    });

    it("silently skips non-member in public channel without mention", async () => {
      (UserUtils.getUserRole as jest.Mock).mockResolvedValue("none");
      const event = makeEvent({ text: "hello" });
      const result = await priv(handler).shouldRejectNonMemberRequest(
        event,
        mockSay,
      );
      expect(result).toBe(true);
      // No rejection message sent (silent skip)
      expect(mockSay).not.toHaveBeenCalled();
    });

    it("sends rejection message to non-member in DM", async () => {
      (UserUtils.getUserRole as jest.Mock).mockResolvedValue("none");
      t.channelConfig.isDirectMessage = jest.fn().mockReturnValue(true);
      const event = makeEvent({ text: "hello", channel_type: "im" });
      const result = await priv(handler).shouldRejectNonMemberRequest(
        event,
        mockSay,
      );
      expect(result).toBe(true);
      // Rejection message sent via sendMessage → mockSay
      expect(mockSay).toHaveBeenCalled();
    });

    it("sends rejection message to non-member with explicit mention", async () => {
      (UserUtils.getUserRole as jest.Mock).mockResolvedValue("none");
      const event = makeEvent({ text: "hello", explicitMention: true });
      const result = await priv(handler).shouldRejectNonMemberRequest(
        event,
        mockSay,
      );
      expect(result).toBe(true);
      expect(mockSay).toHaveBeenCalled();
    });
  });

  describe("shouldSkipDueToMultipleParticipants", () => {
    it("does NOT skip when explicitMention is true", async () => {
      const event = makeEvent({ explicitMention: true });
      const result =
        await priv(handler).shouldSkipDueToMultipleParticipants(event);
      expect(result).toBe(false);
    });

    it("does NOT skip bot messages", async () => {
      const event = makeEvent({ bot_id: "B123" });
      const result =
        await priv(handler).shouldSkipDueToMultipleParticipants(event);
      expect(result).toBe(false);
    });

    it("does NOT skip bot_message subtype", async () => {
      const event = makeEvent({ subtype: "bot_message" });
      const result =
        await priv(handler).shouldSkipDueToMultipleParticipants(event);
      expect(result).toBe(false);
    });

    it("skips when thread has 2+ human participants", async () => {
      t.app.client.conversations.replies.mockResolvedValue({
        messages: [
          { user: "U1", ts: "1.1" },
          { user: "U2", ts: "1.2" },
        ],
      });
      const event = makeEvent({
        user: "U1",
        thread_ts: "1.0",
        ts: "1.3",
      });
      const result =
        await priv(handler).shouldSkipDueToMultipleParticipants(event);
      expect(result).toBe(true);
    });

    it("does NOT skip when only one human in thread", async () => {
      t.app.client.conversations.replies.mockResolvedValue({
        messages: [
          { user: "U1", ts: "1.1" },
          { user: "U1", ts: "1.2" },
          { user: "UBOTID", bot_id: "B1", ts: "1.3" },
        ],
      });
      const event = makeEvent({ user: "U1", thread_ts: "1.0", ts: "1.4" });
      const result =
        await priv(handler).shouldSkipDueToMultipleParticipants(event);
      expect(result).toBe(false);
    });
  });

  describe("checkWillBeEphemeral", () => {
    it("returns false for non-ephemeral channels", async () => {
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(false);
      const result = await priv(handler).checkWillBeEphemeral("C1", false);
      expect(result).toBe(false);
    });

    it("returns false when explicitly mentioned even in ephemeral channel", async () => {
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(true);
      t.channelConfig.getEphemeralTargetUsers = jest
        .fn()
        .mockResolvedValue(["U1"]);
      const result = await priv(handler).checkWillBeEphemeral("C1", true);
      expect(result).toBe(false);
    });

    it("returns false when ephemeral channel has no target users", async () => {
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(true);
      t.channelConfig.getEphemeralTargetUsers = jest.fn().mockResolvedValue([]);
      const result = await priv(handler).checkWillBeEphemeral("C1", false);
      expect(result).toBe(false);
    });

    it("returns true for ephemeral channel with target users and no mention", async () => {
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(true);
      t.channelConfig.getEphemeralTargetUsers = jest
        .fn()
        .mockResolvedValue(["U1", "U2"]);
      const result = await priv(handler).checkWillBeEphemeral("C1", false);
      expect(result).toBe(true);
    });
  });

  describe("shouldShowReactions", () => {
    it("returns true for non-ephemeral messages", async () => {
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(false);
      const event = makeEvent();
      const result = await handler.shouldShowReactions(event);
      expect(result).toBe(true);
    });

    it("returns false for ephemeral messages", async () => {
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(true);
      t.channelConfig.getEphemeralTargetUsers = jest
        .fn()
        .mockResolvedValue(["U1"]);
      const event = makeEvent({ explicitMention: false });
      const result = await handler.shouldShowReactions(event);
      expect(result).toBe(false);
    });

    it("returns true for ephemeral channel when bot is explicitly mentioned", async () => {
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(true);
      t.channelConfig.getEphemeralTargetUsers = jest
        .fn()
        .mockResolvedValue(["U1"]);
      const event = makeEvent({ explicitMention: true });
      const result = await handler.shouldShowReactions(event);
      expect(result).toBe(true);
    });
  });

  describe("markSkipped", () => {
    beforeEach(() => {
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.getEphemeralTargetUsers = jest.fn().mockResolvedValue([]);
    });

    it("registers message, adds SKIPPED reaction, returns true", async () => {
      const event = makeEvent();
      const result = await priv(handler).markSkipped(event);
      expect(result).toBe(true);
      expect(t.reactionManager.registerMessage).toHaveBeenCalledWith(
        expect.any(String),
        "C456",
        "1234567890.123456",
      );
      expect(t.reactionManager.updateReaction).toHaveBeenCalledWith(
        expect.any(String),
        "see_no_evil",
      );
    });

    it("skips reaction for ephemeral messages", async () => {
      t.channelConfig.shouldUseEphemeralMessaging.mockResolvedValue(true);
      t.channelConfig.getEphemeralTargetUsers.mockResolvedValue(["U1"]);
      const event = makeEvent({ explicitMention: false });
      const result = await priv(handler).markSkipped(event);
      expect(result).toBe(true);
      expect(t.reactionManager.registerMessage).toHaveBeenCalled();
      expect(t.reactionManager.updateReaction).not.toHaveBeenCalled();
    });
  });

  describe("prepareEventForHandling", () => {
    beforeEach(() => {
      t.channelConfig.isDirectMessage = jest.fn().mockReturnValue(false);
      t.channelConfig.getChannelName = jest.fn().mockResolvedValue("general");
      t.channelConfig.shouldHandleMessage = jest.fn().mockResolvedValue(true);
    });

    it("detects @mention and strips it from text", async () => {
      const event = makeEvent({ text: "<@UBOTID> help me" });
      const { shouldHandle, event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(shouldHandle).toBe(true);
      expect(normalized.explicitMention).toBe(true);
      expect(normalized.text).toBe("help me");
    });

    it("sets explicitMention for mid-sentence @mention", async () => {
      const event = makeEvent({ text: "hey <@UBOTID> can you help?" });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.explicitMention).toBe(true);
      expect(normalized.text).toBe("hey  can you help?");
    });

    it("preserves other user mentions when stripping bot mention", async () => {
      const event = makeEvent({
        text: "Please ask <@U123> about this, <@UBOTID>",
      });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.explicitMention).toBe(true);
      expect(normalized.text).toBe("Please ask <@U123> about this,");
    });

    it("detects legacy <@ID|label> mention format (e.g. Slackbot reminders)", async () => {
      const event = makeEvent({
        text: 'Reminder: Send "<@UBOTID|mybot> what is 2+2?".',
      });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.explicitMention).toBe(true);
      expect(normalized.text).toBe('Reminder: Send " what is 2+2?".');
    });

    it("does not strip labeled mentions of other users", async () => {
      const event = makeEvent({
        text: "ask <@U123|someone> instead",
      });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.explicitMention).toBe(false);
      expect(normalized.text).toBe("ask <@U123|someone> instead");
    });

    it("does not flag mention when bot ID is missing", async () => {
      t.app.client.auth.test.mockResolvedValue({ user_id: "" });
      const event = makeEvent({ text: "<@UBOTID> help" });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.explicitMention).toBe(false);
    });

    it("detects :postit: prefix and sets replyBroadcast", async () => {
      const event = makeEvent({ text: ":postit: share this" });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.replyBroadcast).toBe(true);
      expect(normalized.text).toBe("share this");
    });

    it("handles [DEBUG] :postit: prefix", async () => {
      const event = makeEvent({ text: "[DEBUG] :postit: share this" });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.replyBroadcast).toBe(true);
      expect(normalized.text).toBe("[DEBUG] share this");
    });

    it("uses provided channel name instead of fetching", async () => {
      const event = makeEvent({ text: "hello" });
      await priv(handler).prepareEventForHandling(event, "my-channel");
      expect(t.channelConfig.shouldHandleMessage).toHaveBeenCalledWith(
        false,
        false,
        expect.any(String),
        "my-channel",
        undefined,
      );
      // Should NOT have called getChannelName since name was provided
      expect(t.channelConfig.getChannelName).not.toHaveBeenCalled();
    });

    it("skips channel name lookup for DMs", async () => {
      t.channelConfig.isDirectMessage = jest.fn().mockReturnValue(true);
      const event = makeEvent({ text: "hello", channel_type: "im" });
      await priv(handler).prepareEventForHandling(event);
      expect(t.channelConfig.getChannelName).not.toHaveBeenCalled();
    });

    it("passes channel_type to getChannelName for non-DM channels", async () => {
      const event = makeEvent({ text: "hello", channel_type: "channel" });
      await priv(handler).prepareEventForHandling(event);
      expect(t.channelConfig.getChannelName).toHaveBeenCalledWith(
        "C456",
        "channel",
      );
    });

    it("returns shouldHandle=false when channelConfig says no", async () => {
      t.channelConfig.shouldHandleMessage.mockResolvedValue(false);
      const event = makeEvent({ text: "hello" });
      const { shouldHandle } =
        await priv(handler).prepareEventForHandling(event);
      expect(shouldHandle).toBe(false);
    });

    it("passes workflow_id to shouldHandleMessage", async () => {
      const event = makeEvent({ text: "hello", workflow_id: "WF123" });
      await priv(handler).prepareEventForHandling(event);
      expect(t.channelConfig.shouldHandleMessage).toHaveBeenCalledWith(
        expect.any(Boolean),
        expect.any(Boolean),
        expect.any(String),
        expect.any(String),
        "WF123",
      );
    });

    it("does not duplicate text when blocks repeat the same content", async () => {
      const event = makeEvent({
        text: "seeing *two* deploys",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "seeing " },
                  { type: "text", text: "two", style: { bold: true } },
                  { type: "text", text: " deploys" },
                ],
              },
            ],
          },
        ],
      });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.text).toBe("seeing *two* deploys");
    });

    it("falls back to block text when text is empty", async () => {
      const event = makeEvent({
        text: "",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "block only" } },
        ],
      });
      const { event: normalized } =
        await priv(handler).prepareEventForHandling(event);
      expect(normalized.text).toBe("block only");
    });
  });

  describe("sendResponse — final reaction", () => {
    const mockSay = jest.fn();

    beforeEach(() => {
      mockSay.mockClear();
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.getEphemeralTargetUsers = jest.fn().mockResolvedValue([]);
      t.channelConfig.getEphemeralTargetChannels = jest
        .fn()
        .mockResolvedValue([]);
      t.channelConfig.isConditionalReplyChannel = jest
        .fn()
        .mockResolvedValue(true);
      t.channelConfig.getChannelName = jest.fn().mockResolvedValue("general");
    });

    it("shows SKIPPED reaction when shouldNotRespond is true and no custom action", async () => {
      const event = makeEvent();
      const result = {
        messages: ["some response"],
        shouldNotRespond: true,
      };
      await priv(handler).sendResponse(event, result, mockSay, Date.now());
      expect(t.reactionManager.updateReaction).toHaveBeenCalledWith(
        expect.any(String),
        "see_no_evil", // REACTIONS.SKIPPED
      );
    });

    it("does not set a reaction when an custom action was invoked (registry owns the lifecycle)", async () => {
      const event = makeEvent();
      const result = {
        messages: ["some response"],
        shouldNotRespond: true,
        confirmationDialogPosted: true,
      };
      await priv(handler).sendResponse(event, result, mockSay, Date.now());
      expect(t.reactionManager.updateReaction).not.toHaveBeenCalled();
    });

    it("shows COMPLETE reaction when shouldNotRespond is false (normal reply)", async () => {
      t.channelConfig.isConditionalReplyChannel = jest
        .fn()
        .mockResolvedValue(false);
      const event = makeEvent();
      const result = {
        messages: ["some response"],
        shouldNotRespond: false,
      };
      await priv(handler).sendResponse(event, result, mockSay, Date.now());
      expect(t.reactionManager.updateReaction).toHaveBeenCalledWith(
        expect.any(String),
        "white_check_mark", // REACTIONS.COMPLETE
      );
    });

    it("tracks message processed with agentCouldHelp false on DO_NOT_RESPOND", async () => {
      const event = makeEvent();
      const result = {
        messages: [],
        shouldNotRespond: true,
        doNotRespondOptOut: true,
        costUsd: 0.015,
      };
      await priv(handler).sendResponse(event, result, mockSay, Date.now());
      expect(trackMessageProcessed).toHaveBeenCalledWith(
        expect.objectContaining({
          agentCouldHelp: false,
          costUsd: 0.015,
          slackAppAnswer: "",
        }),
      );
    });

    it("tracks action-only successes as helpful even when chat reply is suppressed", async () => {
      const event = makeEvent();
      const result = {
        messages: [],
        shouldNotRespond: true,
        confirmationDialogPosted: true,
        costUsd: 0.02,
      };
      await priv(handler).sendResponse(event, result, mockSay, Date.now());
      expect(trackMessageProcessed).toHaveBeenCalledWith(
        expect.objectContaining({
          agentCouldHelp: true,
          costUsd: 0.02,
        }),
      );
    });

    it("tracks isSmartReply true for proactive smart-reply turns", async () => {
      const event = makeEvent({ smartReply: true });
      const result = {
        messages: ["helpful answer"],
        shouldNotRespond: false,
      };
      await priv(handler).sendResponse(event, result, mockSay, Date.now());
      expect(trackMessageProcessed).toHaveBeenCalledWith(
        expect.objectContaining({
          isSmartReply: true,
        }),
      );
    });

    it("tracks isSmartReply false for direct @-mention and DM turns", async () => {
      const event = makeEvent({ explicitMention: true });
      const result = {
        messages: ["helpful answer"],
        shouldNotRespond: false,
      };
      await priv(handler).sendResponse(event, result, mockSay, Date.now());
      expect(trackMessageProcessed).toHaveBeenCalledWith(
        expect.objectContaining({
          isSmartReply: false,
        }),
      );
    });
  });

  describe("claimLatestSessionMessage (thread coalescing)", () => {
    const claim = (sessionKey: string, ts: string) =>
      priv(handler).claimLatestSessionMessage(sessionKey, ts);
    const isLatest = (sessionKey: string, ts: string) =>
      priv(handler).isLatestSessionMessage(sessionKey, ts);

    it("claims the first message in a session", () => {
      expect(claim("s1", "100.1")).toBe(true);
      expect(isLatest("s1", "100.1")).toBe(true);
    });

    it("lets a newer message supersede and aborts the in-flight one", () => {
      expect(claim("s1", "100.1")).toBe(true);

      // The earlier message is mid-flight when the follow-up arrives.
      const controller = new AbortController();
      priv(handler).activeControllers.set("s1", controller);

      expect(claim("s1", "100.2")).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(isLatest("s1", "100.2")).toBe(true);
      expect(isLatest("s1", "100.1")).toBe(false);
    });

    it("drops an older, out-of-order delivery", () => {
      expect(claim("s1", "100.2")).toBe(true);
      expect(claim("s1", "100.1")).toBe(false);
      expect(isLatest("s1", "100.2")).toBe(true);
    });

    it("keeps different sessions independent", () => {
      expect(claim("s1", "100.1")).toBe(true);
      expect(claim("s2", "100.1")).toBe(true);
      expect(isLatest("s1", "100.1")).toBe(true);
      expect(isLatest("s2", "100.1")).toBe(true);
    });

    it("releases the marker so a later message can be claimed again", () => {
      expect(claim("s1", "100.1")).toBe(true);
      priv(handler).releaseLatestSessionMessage("s1", "100.1");
      expect(isLatest("s1", "100.1")).toBe(false);
      expect(claim("s1", "200.1")).toBe(true);
    });
  });

  describe("windowHasExplicitMention", () => {
    const claimMention = (
      sessionKey: string,
      ts: string,
      explicitMention: boolean,
      text = "hi",
    ) =>
      priv(handler).claimLatestSessionMessage(
        sessionKey,
        ts,
        text,
        explicitMention,
      );
    const hasMention = (sessionKey: string) =>
      priv(handler).windowHasExplicitMention(sessionKey);

    it("returns false for a session with no coalescing window", () => {
      expect(hasMention("s1")).toBe(false);
    });

    it("mirrors the message's own flag for a single-message window", () => {
      expect(claimMention("s1", "100.1", false)).toBe(true);
      expect(hasMention("s1")).toBe(false);

      expect(claimMention("s2", "100.1", true)).toBe(true);
      expect(hasMention("s2")).toBe(true);
    });

    it("returns false when no folded message mentioned the bot", () => {
      claimMention("s1", "100.1", false);
      claimMention("s1", "100.2", false);
      expect(hasMention("s1")).toBe(false);
    });

    it("returns true when only an earlier folded message mentioned the bot", () => {
      claimMention("s1", "100.1", true);
      claimMention("s1", "100.2", false);
      claimMention("s1", "100.3", false);
      expect(hasMention("s1")).toBe(true);
    });

    it("returns true when only the latest message mentioned the bot", () => {
      claimMention("s1", "100.1", false);
      claimMention("s1", "100.2", true);
      expect(hasMention("s1")).toBe(true);
    });

    it("does not leak a mention across sessions", () => {
      claimMention("s1", "100.1", true);
      claimMention("s2", "100.1", false);
      expect(hasMention("s1")).toBe(true);
      expect(hasMention("s2")).toBe(false);
    });

    it("forgets the mention once the window is released", () => {
      claimMention("s1", "100.1", true);
      claimMention("s1", "100.2", false);
      priv(handler).releaseLatestSessionMessage("s1", "100.2");
      expect(hasMention("s1")).toBe(false);

      // A brand-new window after the release starts clean.
      claimMention("s1", "200.1", false);
      expect(hasMention("s1")).toBe(false);
    });

    it("keeps the mention when the same message is delivered twice", () => {
      expect(claimMention("s1", "100.1", true)).toBe(true);
      // Slack retries deliver the same ts again; it loses the claim but must
      // not drop the mention already recorded for it.
      expect(claimMention("s1", "100.1", false)).toBe(false);
      expect(hasMention("s1")).toBe(true);
    });
  });

  describe("handleMessage — distinct messages each answered", () => {
    let processClaudeStream: jest.Mock;

    beforeEach(() => {
      // The 12h reaction-cleanup timer in cleanup() would otherwise leak.
      jest.useFakeTimers();

      (UserUtils.getUserRole as jest.Mock).mockResolvedValue("member");

      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.getEphemeralTargetUsers = jest.fn().mockResolvedValue([]);
      t.channelConfig.getEphemeralTargetChannels = jest
        .fn()
        .mockResolvedValue([]);
      t.channelConfig.isNonEphemeralConditionalChannel = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.isConditionalReplyChannel = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.getGeneralContextForChannel = jest
        .fn()
        .mockResolvedValue("");
      t.channelConfig.getContextSource = jest.fn().mockResolvedValue(null);
      t.channelConfig.getChannelName = jest.fn().mockResolvedValue("general");
      t.channelConfig.isDirectMessage = jest.fn().mockReturnValue(false);
      t.channelConfig.getChannelModelOverride = jest
        .fn()
        .mockResolvedValue(undefined);

      t.claudeHandler.getSession = jest.fn().mockReturnValue(undefined);
      t.claudeHandler.createSession = jest
        .fn()
        .mockReturnValue({ workingDirectory: "/tmp/work" });

      processClaudeStream = jest.fn().mockResolvedValue({
        messages: ["Here is your answer."],
        shouldNotRespond: false,
        toolCalls: [],
        turnCount: 1,
      });
      priv(handler).messageProcessor.processClaudeStream = processClaudeStream;
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it("runs the pipeline for each distinct message", async () => {
      await handler.handleMessage(
        makeEvent({ text: "q1", explicitMention: true, ts: "555.1" }),
        jest.fn(),
      );
      await handler.handleMessage(
        makeEvent({ text: "q2", explicitMention: true, ts: "555.2" }),
        jest.fn(),
      );

      expect(processClaudeStream).toHaveBeenCalledTimes(2);
    });
  });

  describe("handleMessage — coalescing thread follow-ups", () => {
    let processClaudeStream: jest.Mock;

    beforeEach(() => {
      jest.useFakeTimers();

      (UserUtils.getUserRole as jest.Mock).mockResolvedValue("member");

      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.getEphemeralTargetUsers = jest.fn().mockResolvedValue([]);
      t.channelConfig.getEphemeralTargetChannels = jest
        .fn()
        .mockResolvedValue([]);
      t.channelConfig.isNonEphemeralConditionalChannel = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.isConditionalReplyChannel = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.getGeneralContextForChannel = jest
        .fn()
        .mockResolvedValue("");
      t.channelConfig.getContextSource = jest.fn().mockResolvedValue(null);
      t.channelConfig.getChannelName = jest.fn().mockResolvedValue("general");
      t.channelConfig.isDirectMessage = jest.fn().mockReturnValue(false);
      t.channelConfig.getChannelModelOverride = jest
        .fn()
        .mockResolvedValue(undefined);

      t.claudeHandler.getSession = jest.fn().mockReturnValue(undefined);
      t.claudeHandler.createSession = jest
        .fn()
        .mockReturnValue({ workingDirectory: "/tmp/work" });

      processClaudeStream = jest.fn();
      priv(handler).messageProcessor.processClaudeStream = processClaudeStream;
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it("posts one combined reply and drops the superseded message when a follow-up arrives mid-thinking", async () => {
      let markStreamStarted: () => void;
      const streamStarted = new Promise<void>(resolve => {
        markStreamStarted = resolve;
      });
      let resolveFirstStream: (result: unknown) => void;
      const firstStream = new Promise(resolve => {
        resolveFirstStream = resolve;
      });

      // First message hangs "thinking" until we resolve it; the follow-up
      // resolves immediately with the combined answer.
      processClaudeStream
        .mockImplementationOnce(() => {
          markStreamStarted();
          return firstStream;
        })
        .mockResolvedValue({
          messages: ["Combined answer to both messages."],
          shouldNotRespond: false,
          toolCalls: [],
          turnCount: 1,
        });

      const sayFirst = jest.fn();
      const sayFollowUp = jest.fn();

      const firstDelivery = handler.handleMessage(
        makeEvent({ text: "first", explicitMention: true, ts: "600.1" }),
        sayFirst,
      );
      // Wait until the first message is actually mid-thinking.
      await streamStarted;

      // A follow-up lands in the same thread while the bot is still thinking.
      await handler.handleMessage(
        makeEvent({
          text: "second, more context",
          explicitMention: true,
          ts: "600.2",
          thread_ts: "600.1",
        }),
        sayFollowUp,
      );

      // The first message's (now superseded) stream finally returns.
      resolveFirstStream!({
        messages: ["Answer to only the first message."],
        shouldNotRespond: false,
        toolCalls: [],
        turnCount: 1,
      });
      await firstDelivery;

      expect(sayFollowUp).toHaveBeenCalled();
      expect(sayFirst).not.toHaveBeenCalled();

      // The winning (follow-up) run's prompt folds both messages into one
      // combined query rather than treating the first as background context.
      const followUpPrompt = processClaudeStream.mock.calls[1][0] as string;
      const userQuery = followUpPrompt.split("## User Query:\n")[1] ?? "";
      expect(userQuery).toContain("first");
      expect(userQuery).toContain("second, more context");
    });

    it("answers the coalesced burst on a fresh session instead of resuming the superseded turns", async () => {
      // A prior exchange in this thread left a resumable session id.
      t.claudeHandler.createSession = jest
        .fn()
        .mockReturnValue({ workingDirectory: "/tmp/work", sessionId: "prior" });

      let markStreamStarted: () => void;
      const streamStarted = new Promise<void>(resolve => {
        markStreamStarted = resolve;
      });
      let resolveFirstStream: (result: unknown) => void;
      const firstStream = new Promise(resolve => {
        resolveFirstStream = resolve;
      });

      // Snapshot the session id each run actually used, since the runs share
      // one mutable session object.
      const sessionIdAtCall: (string | undefined)[] = [];
      processClaudeStream
        .mockImplementationOnce(
          (_prompt: string, session: { sessionId?: string }) => {
            sessionIdAtCall.push(session.sessionId);
            markStreamStarted();
            return firstStream;
          },
        )
        .mockImplementation(
          (_prompt: string, session: { sessionId?: string }) => {
            sessionIdAtCall.push(session.sessionId);
            return Promise.resolve({
              messages: ["Combined answer."],
              shouldNotRespond: false,
              toolCalls: [],
              turnCount: 1,
            });
          },
        );

      const firstDelivery = handler.handleMessage(
        makeEvent({ text: "first", explicitMention: true, ts: "700.1" }),
        jest.fn(),
      );
      await streamStarted;

      await handler.handleMessage(
        makeEvent({
          text: "second",
          explicitMention: true,
          ts: "700.2",
          thread_ts: "700.1",
        }),
        jest.fn(),
      );

      resolveFirstStream!({
        messages: [],
        shouldNotRespond: false,
        toolCalls: [],
        turnCount: 1,
      });
      await firstDelivery;

      // The superseded first run still resumed the prior session; the winning
      // coalesced run starts fresh so the model doesn't read the superseded
      // turns as already-answered and reply to only the newest question.
      expect(sessionIdAtCall[0]).toBe("prior");
      expect(sessionIdAtCall[1]).toBeUndefined();
    });

    describe("in an ephemeral channel", () => {
      beforeEach(() => {
        t.channelConfig.shouldUseEphemeralMessaging = jest
          .fn()
          .mockResolvedValue(true);
        t.channelConfig.getEphemeralTargetUsers = jest
          .fn()
          .mockResolvedValue(["U123"]);
        t.channelConfig.shouldSendDM = jest.fn().mockResolvedValue(false);
      });

      it("posts the coalesced reply publicly when only the folded earlier message @-mentioned the bot", async () => {
        let markStreamStarted: () => void;
        const streamStarted = new Promise<void>(resolve => {
          markStreamStarted = resolve;
        });
        let resolveFirstStream: (result: unknown) => void;
        const firstStream = new Promise(resolve => {
          resolveFirstStream = resolve;
        });

        processClaudeStream
          .mockImplementationOnce(() => {
            markStreamStarted();
            return firstStream;
          })
          .mockResolvedValue({
            messages: ["Combined answer to both messages."],
            shouldNotRespond: false,
            toolCalls: [],
            turnCount: 1,
          });

        const sayFirst = jest.fn();
        const sayFollowUp = jest.fn();

        // The message that opened the burst tagged the bot.
        const firstDelivery = handler.handleMessage(
          makeEvent({
            text: "<@UBOTID> first",
            explicitMention: true,
            ts: "800.1",
          }),
          sayFirst,
        );
        await streamStarted;

        // The follow-up that wins the burst does not tag the bot on its own.
        await handler.handleMessage(
          makeEvent({
            text: "second, more context",
            explicitMention: false,
            ts: "800.2",
            thread_ts: "800.1",
          }),
          sayFollowUp,
        );

        resolveFirstStream!({
          messages: ["Answer to only the first message."],
          shouldNotRespond: false,
          toolCalls: [],
          turnCount: 1,
        });
        await firstDelivery;

        // The burst answers a message that tagged the bot, so the single reply
        // stays public in-thread instead of being routed ephemerally.
        expect(t.app.client.chat.postEphemeral).not.toHaveBeenCalled();
        expect(sayFollowUp).toHaveBeenCalled();
        expect(sayFirst).not.toHaveBeenCalled();
        expect(sayFollowUp.mock.calls[0][0]).toMatchObject({
          thread_ts: "800.1",
        });

        // The superseded mentioned message was answered by the combined reply,
        // so it gets no "skipped" reaction — any in-progress reaction is
        // cleared instead, leaving it bare.
        expect(t.reactionManager.updateReaction).not.toHaveBeenCalledWith(
          "U123:C456:800.1:800.1",
          "see_no_evil",
        );
        expect(t.reactionManager.clearReaction).toHaveBeenCalledWith(
          "U123:C456:800.1:800.1",
        );
      });

      it("treats the winning run as mentioned for processing, not just delivery", async () => {
        let markStreamStarted: () => void;
        const streamStarted = new Promise<void>(resolve => {
          markStreamStarted = resolve;
        });
        let resolveFirstStream: (result: unknown) => void;
        const firstStream = new Promise(resolve => {
          resolveFirstStream = resolve;
        });

        processClaudeStream
          .mockImplementationOnce(() => {
            markStreamStarted();
            return firstStream;
          })
          .mockResolvedValue({
            messages: ["Combined answer."],
            shouldNotRespond: false,
            toolCalls: [],
            turnCount: 1,
          });

        const firstDelivery = handler.handleMessage(
          makeEvent({
            text: "<@UBOTID> first",
            explicitMention: true,
            ts: "810.1",
          }),
          jest.fn(),
        );
        await streamStarted;

        await handler.handleMessage(
          makeEvent({
            text: "second, more context",
            explicitMention: false,
            ts: "810.2",
            thread_ts: "810.1",
          }),
          jest.fn(),
        );

        resolveFirstStream!({
          messages: ["Answer to only the first message."],
          shouldNotRespond: false,
          toolCalls: [],
          turnCount: 1,
        });
        await firstDelivery;

        // The winning run's own message didn't tag the bot, but the burst did —
        // the model context and mode resolution must see the effective mention.
        const slackContext = processClaudeStream.mock.calls[1][3];
        expect(slackContext.explicitMention).toBe(true);
        expect(slackContext.reactionKey).toBeDefined();
      });

      it("still routes ephemerally when the lone message in the window has no @-mention", async () => {
        processClaudeStream.mockResolvedValue({
          messages: ["Answer."],
          shouldNotRespond: false,
          toolCalls: [],
          turnCount: 1,
        });

        const say = jest.fn();
        await handler.handleMessage(
          makeEvent({
            text: "just asking",
            explicitMention: false,
            ts: "900.1",
          }),
          say,
        );

        expect(t.app.client.chat.postEphemeral).toHaveBeenCalled();
        expect(say).not.toHaveBeenCalled();
      });
    });
  });

  describe("handleSpecialCommands", () => {
    const mockSay = jest.fn();

    beforeEach(() => {
      mockSay.mockClear();
      t.channelConfig.reloadConfiguration = jest.fn();
      t.channelConfig.shouldUseEphemeralMessaging = jest
        .fn()
        .mockResolvedValue(false);
      t.channelConfig.getEphemeralTargetUsers = jest.fn().mockResolvedValue([]);
      t.channelConfig.getEphemeralTargetChannels = jest
        .fn()
        .mockResolvedValue([]);
      t.channelConfig.getContextSource = jest.fn().mockResolvedValue(null);
    });

    it('handles "cache reload" command', async () => {
      const event = makeEvent({ text: "cache reload" });
      const result = await priv(handler).handleSpecialCommands(event, mockSay);
      expect(result).toBe(true);
      expect(t.channelConfig.reloadConfiguration).toHaveBeenCalled();
      expect(mockSay).toHaveBeenCalled();
    });

    it("returns false for normal messages", async () => {
      const event = makeEvent({ text: "hello" });
      const result = await priv(handler).handleSpecialCommands(event, mockSay);
      expect(result).toBe(false);
    });

    it("returns false when text is empty", async () => {
      const event = makeEvent({ text: undefined });
      const result = await priv(handler).handleSpecialCommands(event, mockSay);
      expect(result).toBe(false);
    });
  });
});
