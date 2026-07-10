/**
 * Unit tests for ReactionManager.updateReaction — the single reaction-setting
 * method. It tracks the current emoji per session so it removes the right one
 * and skips redundant updates, and no-ops once the session is cleaned up.
 */

jest.mock("./config", () => ({
  config: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "test-secret",
    },
    anthropic: { apiKey: "test-key", model: "claude-opus-4-8" },
    slackWorkspaceUrl: "https://test.slack.com",
    baseDirectory: "/tmp/test",
    persistDir: "/tmp/test-persist",
    debug: false,
  },
}));

import { ReactionManager } from "./reaction-manager";

describe("ReactionManager.updateReaction", () => {
  const KEY = "sess:1";
  const CHANNEL = "C123";
  const TS = "1700000000.000100";

  const makeApp = (): any => ({
    client: {
      reactions: {
        add: jest.fn().mockResolvedValue({ ok: true }),
        remove: jest.fn().mockResolvedValue({ ok: true }),
      },
    },
  });

  it("adds the reaction (with no remove) on the first update", async () => {
    const app = makeApp();
    const manager = new ReactionManager(app);
    manager.registerMessage(KEY, CHANNEL, TS);

    await manager.updateReaction(KEY, "hourglass_flowing_sand");

    expect(app.client.reactions.remove).not.toHaveBeenCalled();
    expect(app.client.reactions.add).toHaveBeenCalledWith({
      channel: CHANNEL,
      timestamp: TS,
      name: "hourglass_flowing_sand",
    });
  });

  it("removes the current reaction before adding the next one", async () => {
    const app = makeApp();
    const manager = new ReactionManager(app);
    manager.registerMessage(KEY, CHANNEL, TS);

    await manager.updateReaction(KEY, "hourglass_flowing_sand");
    await manager.updateReaction(KEY, "white_check_mark");

    expect(app.client.reactions.remove).toHaveBeenCalledWith({
      channel: CHANNEL,
      timestamp: TS,
      name: "hourglass_flowing_sand",
    });
    expect(app.client.reactions.add).toHaveBeenLastCalledWith({
      channel: CHANNEL,
      timestamp: TS,
      name: "white_check_mark",
    });
  });

  it("is a no-op when the emoji is already current", async () => {
    const app = makeApp();
    const manager = new ReactionManager(app);
    manager.registerMessage(KEY, CHANNEL, TS);

    await manager.updateReaction(KEY, "x");
    app.client.reactions.add.mockClear();
    await manager.updateReaction(KEY, "x");

    expect(app.client.reactions.add).not.toHaveBeenCalled();
  });

  it("no-ops when the session is not registered", async () => {
    const app = makeApp();
    const manager = new ReactionManager(app);

    await manager.updateReaction("unknown", "x");

    expect(app.client.reactions.add).not.toHaveBeenCalled();
  });

  it("stops updating once the session has been cleaned up", async () => {
    const app = makeApp();
    const manager = new ReactionManager(app);
    manager.registerMessage(KEY, CHANNEL, TS);
    await manager.updateReaction(KEY, "hourglass_flowing_sand");
    manager.cleanupSession(KEY);
    app.client.reactions.add.mockClear();

    await manager.updateReaction(KEY, "white_check_mark");

    expect(app.client.reactions.add).not.toHaveBeenCalled();
  });
});
