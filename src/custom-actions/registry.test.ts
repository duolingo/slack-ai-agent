/**
 * Unit tests for the custom-action reaction lifecycle.
 *
 * Once an custom action is invoked, SlackHandler.sendResponse cedes the
 * original message's reaction to the registry, which owns the whole lifecycle:
 * waiting-on-human → complete / error for the confirmation flow, and
 * complete / error directly for YOLO auto-approvals (no human to wait on).
 */

jest.mock("../config", () => ({
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

jest.mock("../tracking", () => ({
  generateMessageId: jest.fn(() => "test-msg-id"),
}));

import { CustomActionRegistry } from "./registry";
import { REACTIONS } from "../reaction-manager";

describe("CustomActionRegistry reaction lifecycle", () => {
  const ORIGINAL_CHANNEL = "C123";
  const ORIGINAL_TS = "1700000000.000100";
  const REACTION_KEY = "react-key-abc";

  let app: any;
  let reactionManager: any;
  let handlers: Record<string, any>;
  let registry: CustomActionRegistry;

  const makeCtx = (overrides: Record<string, any> = {}): any => ({
    userId: "U123",
    channel: ORIGINAL_CHANNEL,
    channelType: "channel",
    messageTs: ORIGINAL_TS,
    messageText: "hello",
    reactionKey: REACTION_KEY,
    ...overrides,
  });

  const makeAction = (overrides: Record<string, any> = {}): any => ({
    name: "test-action",
    description: "Test action",
    inputSchema: {},
    buildConfirmationBlocks: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const seedSession = (sessionKey: string, ctx: any) =>
    (registry as any).pendingSessions.set(sessionKey, {
      actionName: "test-action",
      params: {},
      ctx,
      messageTs: "dialog-ts",
      createdAt: new Date(),
    });

  const clickApprove = (sessionKey: string) =>
    handlers["approve_action"]({
      ack: jest.fn(),
      body: {
        actions: [{ value: "test-action:" + sessionKey }],
        user: { id: "U999" },
        container: { channel_id: ORIGINAL_CHANNEL, message_ts: "dialog-ts" },
        state: { values: {} },
      },
    });

  const clickCancel = (sessionKey: string) =>
    handlers["cancel_action"]({
      ack: jest.fn(),
      body: {
        actions: [{ value: "test-action:" + sessionKey }],
        container: { channel_id: ORIGINAL_CHANNEL, message_ts: "dialog-ts" },
      },
      client: app.client,
    });

  beforeEach(() => {
    handlers = {};
    app = {
      client: {
        chat: {
          postMessage: jest.fn().mockResolvedValue({ ts: "dialog-ts" }),
          update: jest.fn().mockResolvedValue({}),
        },
      },
      action: jest.fn((id: string, handler: any) => {
        handlers[id] = handler;
      }),
    };
    reactionManager = {
      updateReaction: jest.fn().mockResolvedValue(undefined),
      registerMessage: jest.fn(),
    };
    registry = new CustomActionRegistry(app, reactionManager);
  });

  it("sets waiting-on-human on the original message when a confirmation dialog is posted", async () => {
    registry.register(makeAction());

    await (registry as any).handleToolCall("test-action", {}, makeCtx());

    expect(app.client.chat.postMessage).toHaveBeenCalled();
    // During the turn the message is still tracked, so the registry goes
    // through the session path (keeps currentReactions in sync).
    expect(reactionManager.updateReaction).toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.WAITING_ON_HUMAN,
    );
  });

  it("does not touch the reaction when reactionKey is absent", async () => {
    registry.register(makeAction());

    await (registry as any).handleToolCall(
      "test-action",
      {},
      makeCtx({ reactionKey: undefined }),
    );

    expect(reactionManager.updateReaction).not.toHaveBeenCalled();
  });

  it("flips waiting-on-human to complete when the action is approved", async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    registry.register(makeAction({ execute }));
    registry.setupButtonHandlers();
    seedSession("session-1", makeCtx());

    await clickApprove("session-1");

    expect(execute).toHaveBeenCalled();
    expect(reactionManager.updateReaction).toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.COMPLETE,
    );
  });

  it("sets error when an approved action throws during execution", async () => {
    const execute = jest.fn().mockRejectedValue(new Error("kaboom"));
    registry.register(makeAction({ execute }));
    registry.setupButtonHandlers();
    seedSession("session-2", makeCtx());

    await clickApprove("session-2");

    expect(reactionManager.updateReaction).toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.ERROR,
    );
  });

  it("sets error when the action is cancelled", async () => {
    registry.register(makeAction());
    registry.setupButtonHandlers();
    seedSession("session-3", makeCtx());

    await clickCancel("session-3");

    expect(reactionManager.updateReaction).toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.ERROR,
    );
  });

  it("sets complete (never waiting-on-human) for a successful YOLO auto-approval", async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    registry.register(makeAction({ yoloEmojis: [":yolo-test:"], execute }));

    await (registry as any).handleToolCall(
      "test-action",
      {},
      makeCtx({ messageText: "ship it :yolo-test:" }),
    );

    expect(execute).toHaveBeenCalled();
    expect(reactionManager.updateReaction).toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.COMPLETE,
    );
    expect(reactionManager.updateReaction).not.toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.WAITING_ON_HUMAN,
    );
  });

  it("sets error for a failed YOLO auto-approval", async () => {
    const execute = jest.fn().mockRejectedValue(new Error("boom"));
    registry.register(makeAction({ yoloEmojis: [":yolo-test:"], execute }));

    await (registry as any).handleToolCall(
      "test-action",
      {},
      makeCtx({ messageText: "ship it :yolo-test:" }),
    );

    expect(reactionManager.updateReaction).toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.ERROR,
    );
  });

  it("marks error (not stuck on tool-use) when posting the confirmation dialog fails", async () => {
    registry.register(makeAction());
    app.client.chat.postMessage.mockRejectedValue(new Error("slack down"));

    await expect(
      (registry as any).handleToolCall("test-action", {}, makeCtx()),
    ).rejects.toThrow("slack down");

    expect(reactionManager.updateReaction).toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.ERROR,
    );
  });

  it("invokes immediately when requiresApproval is false", async () => {
    const action = makeAction({
      requiresApproval: false,
      invoke: jest.fn().mockResolvedValue("doc body"),
    });
    registry.register(action);

    const result = await (registry as any).handleToolCall(
      "test-action",
      { url: "https://example.com" },
      makeCtx(),
    );

    expect(action.invoke).toHaveBeenCalled();
    expect(result.content[0].text).toBe("doc body");
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("resolves the reaction to error when approving an action missing from the registry", async () => {
    // Seed a session whose action was never registered (e.g. removed since).
    registry.setupButtonHandlers();
    (registry as any).pendingSessions.set("session-ghost", {
      actionName: "ghost-action",
      params: {},
      ctx: makeCtx(),
      messageTs: "dialog-ts",
      createdAt: new Date(),
    });

    await handlers["approve_action"]({
      ack: jest.fn(),
      body: {
        actions: [{ value: "ghost-action:session-ghost" }],
        user: { id: "U999" },
        container: { channel_id: ORIGINAL_CHANNEL, message_ts: "dialog-ts" },
        state: { values: {} },
      },
    });

    expect(reactionManager.updateReaction).toHaveBeenCalledWith(
      REACTION_KEY,
      REACTIONS.ERROR,
    );
  });
});
