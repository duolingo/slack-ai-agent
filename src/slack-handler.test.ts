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
    anthropic: { apiKey: "test-key", model: "claude-opus-4-6" },
    slackWorkspaceUrl: "https://test.slack.com",
    baseDirectory: "/tmp/test",
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
      ERROR: "x",
      SUPPRESSION_EMOJIS: [":shushing_face:", ":shhh:"],
    },
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

import { SlackHandler } from "./slack-handler";
import { MessageEvent } from "./types";
import { UserUtils } from "./user-utils";

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

  const mockMcpManager = {} as any;
  const mockReactionManager = {
    registerMessage: jest.fn(),
    updateReaction: jest.fn().mockResolvedValue(undefined),
    cleanupSession: jest.fn(),
  } as any;

  const handler = new SlackHandler(
    mockApp,
    mockClaudeHandler,
    mockMcpManager,
    mockReactionManager,
  );

  // Expose the channelConfig mock for per-test configuration
  const channelConfig = (handler as any).channelConfig;

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

  describe("splitMessageForSlack", () => {
    const split = (text: string, max?: number) =>
      priv(handler).splitMessageForSlack(text, max);

    it("returns single chunk for short messages", () => {
      expect(split("hello", 100)).toEqual(["hello"]);
    });

    it("splits long messages into chunks", () => {
      const text = "a".repeat(100);
      const chunks = split(text, 30);
      expect(chunks.length).toBe(4); // 100 / 30 = 3.33 → 4 chunks
      // Each chunk should have part indicator
      expect(chunks[0]).toContain("[Part 1/4]");
      expect(chunks[3]).toContain("[Part 4/4]");
    });

    it("does not add part indicators for single chunk", () => {
      const chunks = split("short", 100);
      expect(chunks[0]).not.toContain("[Part");
    });
  });

  describe("createSafeButtonValue", () => {
    const safe = (data: any) => priv(handler).createSafeButtonValue(data);

    it("includes channel and truncates long fields", () => {
      const result = JSON.parse(
        safe({
          channel: "C123",
          root_ts: "1.1",
          question: "x".repeat(500),
          answer: "y".repeat(500),
        }),
      );
      expect(result.channel).toBe("C123");
      expect(result.root_ts).toBe("1.1");
      expect(result.question.length).toBeLessThanOrEqual(403); // 400 + "..."
      expect(result.answer.length).toBeLessThanOrEqual(403);
    });

    it("omits undefined optional fields", () => {
      const result = JSON.parse(safe({ channel: "C123" }));
      expect(result).toEqual({ channel: "C123" });
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
  });

  describe("createVotingButtonsBlock", () => {
    it("includes channel_type in button payload", () => {
      const block = priv(handler).createVotingButtonsBlock({
        channel: "D1",
        channel_type: "im",
        root_ts: "1.1",
        question: "q",
        answer: "a",
      });
      const parsed = JSON.parse(block.elements[0].value);
      expect(parsed.channel_type).toBe("im");
    });
  });

  describe("isMentionAtNaturalStart", () => {
    const check = (text: string) =>
      priv(handler).isMentionAtNaturalStart(text, "UBOTID");

    it("detects mention at start of message", () => {
      expect(check("<@UBOTID> help me")).toBe(true);
    });

    it("detects mention at start with leading whitespace", () => {
      expect(check("  <@UBOTID> help")).toBe(true);
    });

    it("detects mention after sentence end", () => {
      expect(check("Done. <@UBOTID> what next?")).toBe(true);
    });

    it("detects mention after newline", () => {
      expect(check("line1\n<@UBOTID> line2")).toBe(true);
    });

    it("does not match mention in the middle of a word", () => {
      expect(check("hello<@UBOTID>world")).toBe(false);
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
        "C456",
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
        expect.any(String),
        expect.any(Boolean),
        expect.any(Boolean),
        expect.any(String),
        expect.any(String),
        "WF123",
      );
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
