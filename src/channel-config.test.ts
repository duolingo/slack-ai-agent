// Module mocks must be before imports
jest.mock("./config", () => ({
  config: {
    slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "s" },
    anthropic: { apiKey: "test-key", model: "claude-opus-4-6" },
    slackWorkspaceUrl: "https://test.slack.com",
    baseDirectory: "/tmp/test",
    debug: false,
  },
}));

// Mock fs/yaml so loadConfig doesn't try to read real files
jest.mock("fs", () => ({
  readFileSync: jest.fn().mockReturnValue(
    JSON.stringify({
      contextSources: [],
      conditionalReplyChannels: [],
      ephemeralChannelConfig: {},
      dmNotificationConfig: {},
    }),
  ),
}));
jest.mock("js-yaml", () => ({
  load: jest.fn().mockReturnValue({
    contextSources: [],
    conditionalReplyChannels: [],
    ephemeralChannelConfig: {},
    dmNotificationConfig: {},
  }),
}));

import { ChannelConfigManager } from "./channel-config";
import { SlackChannelType } from "./types";

describe("ChannelConfigManager", () => {
  let manager: ChannelConfigManager;
  let mockApp: any;

  beforeEach(() => {
    manager = new ChannelConfigManager();
    mockApp = {
      client: {
        conversations: {
          info: jest.fn().mockResolvedValue({ channel: { name: "general" } }),
        },
      },
    };
    manager.setApp(mockApp);
  });

  describe("getChannelName", () => {
    it('returns "direct-message" when channelType is "im"', async () => {
      const result = await manager.getChannelName("D12345", "im");
      expect(result).toBe("direct-message");
      // Should not call the Slack API
      expect(mockApp.client.conversations.info).not.toHaveBeenCalled();
    });

    it("queries Slack API for regular channels", async () => {
      const result = await manager.getChannelName("C12345", "channel");
      expect(result).toBe("general");
      expect(mockApp.client.conversations.info).toHaveBeenCalledWith({
        channel: "C12345",
      });
    });

    it("queries Slack API for group channels", async () => {
      const result = await manager.getChannelName("G12345", "group");
      expect(result).toBe("general");
      expect(mockApp.client.conversations.info).toHaveBeenCalledWith({
        channel: "G12345",
      });
    });

    it('returns "direct-message" for DM even with D-prefix channel ID', async () => {
      // Ensures the check uses channelType, not channel ID prefix
      const result = await manager.getChannelName("D99999", "im");
      expect(result).toBe("direct-message");
      expect(mockApp.client.conversations.info).not.toHaveBeenCalled();
    });

    it("does NOT return direct-message for D-prefix channel with non-im type", async () => {
      // A channel ID starting with D but channelType is "channel" should
      // query the API, not assume it's a DM
      const result = await manager.getChannelName("D12345", "channel");
      expect(result).toBe("general");
      expect(mockApp.client.conversations.info).toHaveBeenCalled();
    });

    it("returns undefined when Slack API fails", async () => {
      mockApp.client.conversations.info.mockRejectedValue(
        new Error("channel_not_found"),
      );
      const result = await manager.getChannelName("C12345", "channel");
      expect(result).toBeUndefined();
    });

    it("returns undefined when app is not set", async () => {
      const noAppManager = new ChannelConfigManager();
      const result = await noAppManager.getChannelName("C12345", "channel");
      expect(result).toBeUndefined();
    });
  });

  describe("isDirectMessage", () => {
    it('returns true for "im" channel type', () => {
      expect(manager.isDirectMessage("im")).toBe(true);
    });

    it.each(["channel", "group", "mpim"] as SlackChannelType[])(
      'returns false for "%s" channel type',
      channelType => {
        expect(manager.isDirectMessage(channelType)).toBe(false);
      },
    );

    it("returns false for undefined", () => {
      expect(manager.isDirectMessage(undefined)).toBe(false);
    });
  });

  describe("lookupChannelType", () => {
    it('returns "im" for DM channels', async () => {
      mockApp.client.conversations.info.mockResolvedValue({
        channel: { is_im: true },
      });
      expect(await manager.lookupChannelType("D123")).toBe("im");
    });

    it('returns "mpim" for multi-person DMs', async () => {
      mockApp.client.conversations.info.mockResolvedValue({
        channel: { is_mpim: true },
      });
      expect(await manager.lookupChannelType("G123")).toBe("mpim");
    });

    it('returns "group" for private channels', async () => {
      mockApp.client.conversations.info.mockResolvedValue({
        channel: { is_private: true },
      });
      expect(await manager.lookupChannelType("C123")).toBe("group");
    });

    it('returns "channel" for public channels', async () => {
      mockApp.client.conversations.info.mockResolvedValue({
        channel: { is_private: false },
      });
      expect(await manager.lookupChannelType("C123")).toBe("channel");
    });

    it('defaults to "im" on API error', async () => {
      mockApp.client.conversations.info.mockRejectedValue(
        new Error("channel_not_found"),
      );
      expect(await manager.lookupChannelType("C123")).toBe("im");
    });

    it('defaults to "im" when app is not set', async () => {
      const noAppManager = new ChannelConfigManager();
      expect(await noAppManager.lookupChannelType("C123")).toBe("im");
    });
  });
});
