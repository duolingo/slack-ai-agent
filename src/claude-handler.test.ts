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

jest.mock("./user-utils", () => ({
  UserUtils: {
    getUserRole: jest.fn().mockResolvedValue("member"),
  },
}));

jest.mock("./validation-agent", () => ({
  loadSubagentDefinitions: jest.fn(() => ({})),
}));

import {
  ClaudeHandler,
  DEFAULT_SESSION_MAX_AGE_MS,
  shouldInjectActions,
} from "./claude-handler";

function createHandler(retryOverrides?: {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
}): ClaudeHandler {
  const mockMcpManager = {
    getServerConfiguration: jest.fn().mockReturnValue({}),
    getAllowedTools: jest.fn().mockResolvedValue([]),
    getDisallowedTools: jest.fn().mockReturnValue([]),
    getHighestRole: jest.fn().mockResolvedValue("admin"),
  } as any;

  const handler = new ClaudeHandler(mockMcpManager);

  if (retryOverrides) {
    (handler as any).retryOptions = {
      maxRetries: retryOverrides.maxRetries ?? 3,
      initialDelayMs: retryOverrides.initialDelayMs ?? 1,
      backoffMultiplier: retryOverrides.backoffMultiplier ?? 1,
    };
  }

  return handler;
}

describe("ClaudeHandler", () => {
  describe("getSessionKey", () => {
    let handler: ClaudeHandler;
    beforeEach(() => {
      handler = createHandler();
    });

    it("builds key from userId, channelId, and threadTs", () => {
      expect(handler.getSessionKey("U1", "C2", "111.222")).toBe(
        "U1-C2-111.222",
      );
    });

    it('uses "direct" when threadTs is undefined', () => {
      expect(handler.getSessionKey("U1", "C2")).toBe("U1-C2-direct");
    });

    it('uses "direct" when threadTs is empty string', () => {
      expect(handler.getSessionKey("U1", "C2", "")).toBe("U1-C2-direct");
    });
  });

  describe("session lifecycle", () => {
    let handler: ClaudeHandler;
    beforeEach(() => {
      handler = createHandler();
    });

    it("returns undefined for unknown session", () => {
      expect(handler.getSession("U1", "C2", "111.222")).toBeUndefined();
    });

    it("creates and retrieves a session", () => {
      const session = handler.createSession("U1", "C2", "111.222");
      expect(session.userId).toBe("U1");
      expect(session.channelId).toBe("C2");
      expect(session.threadTs).toBe("111.222");
      expect(session.lastActivity).toBeInstanceOf(Date);

      const retrieved = handler.getSession("U1", "C2", "111.222");
      expect(retrieved).toBe(session);
    });

    it("creates DM session without threadTs", () => {
      const session = handler.createSession("U1", "C2");
      expect(session.threadTs).toBeUndefined();
      expect(handler.getSession("U1", "C2")).toBe(session);
    });

    it("overwrites session with same key", () => {
      const first = handler.createSession("U1", "C2", "111.222");
      const second = handler.createSession("U1", "C2", "111.222");
      expect(handler.getSession("U1", "C2", "111.222")).toBe(second);
      expect(second).not.toBe(first);
    });

    it("keeps sessions with different keys separate", () => {
      const s1 = handler.createSession("U1", "C1", "1.1");
      const s2 = handler.createSession("U1", "C2", "1.1");
      expect(handler.getSession("U1", "C1", "1.1")).toBe(s1);
      expect(handler.getSession("U1", "C2", "1.1")).toBe(s2);
    });
  });

  describe("cleanupInactiveSessions", () => {
    let handler: ClaudeHandler;
    beforeEach(() => {
      handler = createHandler();
    });

    it("removes sessions older than maxAge", () => {
      const session = handler.createSession("U1", "C1", "1.1");
      // Backdate the session
      session.lastActivity = new Date(Date.now() - 60_000);

      handler.cleanupInactiveSessions(30_000); // 30s max age
      expect(handler.getSession("U1", "C1", "1.1")).toBeUndefined();
    });

    it("keeps sessions younger than maxAge", () => {
      const session = handler.createSession("U1", "C1", "1.1");
      session.lastActivity = new Date(); // just now

      handler.cleanupInactiveSessions(30_000);
      expect(handler.getSession("U1", "C1", "1.1")).toBe(session);
    });

    it("keeps sessions younger than default maxAge", () => {
      const session = handler.createSession("U1", "C1", "1.1");
      session.lastActivity = new Date(
        Date.now() - DEFAULT_SESSION_MAX_AGE_MS + 60_000,
      );

      handler.cleanupInactiveSessions();
      expect(handler.getSession("U1", "C1", "1.1")).toBe(session);
    });

    it("removes sessions older than default maxAge", () => {
      const session = handler.createSession("U1", "C1", "1.1");
      session.lastActivity = new Date(
        Date.now() - DEFAULT_SESSION_MAX_AGE_MS - 60_000,
      );

      handler.cleanupInactiveSessions();
      expect(handler.getSession("U1", "C1", "1.1")).toBeUndefined();
    });

    it("handles mix of stale and fresh sessions", () => {
      const stale = handler.createSession("U1", "C1", "1.1");
      stale.lastActivity = new Date(Date.now() - 60_000);

      const fresh = handler.createSession("U2", "C2", "2.2");
      fresh.lastActivity = new Date();

      handler.cleanupInactiveSessions(30_000);
      expect(handler.getSession("U1", "C1", "1.1")).toBeUndefined();
      expect(handler.getSession("U2", "C2", "2.2")).toBe(fresh);
    });

    it("handles empty sessions map", () => {
      expect(() => handler.cleanupInactiveSessions()).not.toThrow();
    });
  });

  describe("simpleRetry", () => {
    let handler: ClaudeHandler;
    beforeEach(() => {
      handler = createHandler({
        maxRetries: 3,
        initialDelayMs: 1, // 1ms delays for fast tests
        backoffMultiplier: 1,
      });
    });

    it("returns on first success", async () => {
      const op = jest.fn().mockResolvedValue("ok");
      const result = await (handler as any).simpleRetry(op);
      expect(result).toBe("ok");
      expect(op).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and eventually succeeds", async () => {
      const op = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("ok");

      const result = await (handler as any).simpleRetry(op);
      expect(result).toBe("ok");
      expect(op).toHaveBeenCalledTimes(3);
    });

    it("throws after exhausting all retries", async () => {
      const op = jest.fn().mockRejectedValue(new Error("always fails"));

      await expect((handler as any).simpleRetry(op)).rejects.toThrow(
        "always fails",
      );
      // 1 initial + 3 retries = 4 calls
      expect(op).toHaveBeenCalledTimes(4);
    });

    it("immediately re-throws AbortError without retrying", async () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      const op = jest.fn().mockRejectedValue(abortError);

      await expect((handler as any).simpleRetry(op)).rejects.toThrow("Aborted");
      expect(op).toHaveBeenCalledTimes(1);
    });

    it("calls onRetry callback with correct attempt number", async () => {
      const op = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("ok");

      const onRetry = jest.fn();
      await (handler as any).simpleRetry(op, onRetry);

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1);
      expect(onRetry).toHaveBeenNthCalledWith(2, 2);
    });

    it("does not call onRetry on first success", async () => {
      const op = jest.fn().mockResolvedValue("ok");
      const onRetry = jest.fn();
      await (handler as any).simpleRetry(op, onRetry);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("applies exponential backoff delays", async () => {
      const customHandler = createHandler({
        maxRetries: 2,
        initialDelayMs: 10,
        backoffMultiplier: 2,
      });

      const sleepSpy = jest
        .spyOn(customHandler as any, "sleep")
        .mockResolvedValue(undefined);

      const op = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("ok");

      await (customHandler as any).simpleRetry(op);

      // attempt 0 fails → delay = 10 * 2^0 = 10ms
      // attempt 1 fails → delay = 10 * 2^1 = 20ms
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 10);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 20);
    });
  });
});

describe("shouldInjectActions", () => {
  const base = {
    channelType: "channel" as const,
    explicitMention: false,
    workflowId: undefined as string | undefined,
    isNonEphemeralConditionalChannel: false,
  };

  it("returns true for DMs", () => {
    expect(shouldInjectActions({ ...base, channelType: "im" })).toBe(true);
  });

  it("returns true for explicit mentions", () => {
    expect(shouldInjectActions({ ...base, explicitMention: true })).toBe(true);
  });

  it("returns true for workflow-triggered messages", () => {
    expect(shouldInjectActions({ ...base, workflowId: "WF123" })).toBe(true);
  });

  it("returns true for non-ephemeral conditional channels", () => {
    expect(
      shouldInjectActions({ ...base, isNonEphemeralConditionalChannel: true }),
    ).toBe(true);
  });

  it("returns false for regular channel messages", () => {
    expect(shouldInjectActions(base)).toBe(false);
  });

  it("returns false for group channels without triggers", () => {
    expect(shouldInjectActions({ ...base, channelType: "group" })).toBe(false);
  });
});
