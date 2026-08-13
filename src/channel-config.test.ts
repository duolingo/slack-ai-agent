// Module mocks must be before imports
jest.mock("./config", () => ({
  config: {
    slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "s" },
    anthropic: { apiKey: "test-key", model: "claude-opus-5" },
    slackWorkspaceUrl: "https://test.slack.com",
    baseDirectory: "/tmp/test",
    persistDir: "/tmp/test-persist",
    debug: false,
  },
}));

// Mock fs/yaml so loadConfig doesn't try to read real files
jest.mock("fs", () => ({
  readFileSync: jest.fn().mockReturnValue(
    JSON.stringify({
      channelSettings: [],
      conditionalReplyChannels: [],
      ephemeralChannelConfig: {},
      dmNotificationConfig: {},
    }),
  ),
}));
jest.mock("js-yaml", () => ({
  load: jest.fn().mockReturnValue({
    channelSettings: [],
    conditionalReplyChannels: [],
    ephemeralChannelConfig: {},
    dmNotificationConfig: {},
  }),
}));

import { load } from "js-yaml";
import { ChannelConfigManager } from "./channel-config";
import { SlackChannelType } from "./types";

const mockedYamlLoad = load as jest.Mock;

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

  describe("isSmartReplyEligibleChannelName", () => {
    const configWith = (smartReply: unknown) => ({
      channelSettings: [],
      conditionalReplyChannels: [],
      ephemeralChannelConfig: {},
      dmNotificationConfig: {},
      smartReply,
    });

    it("is disabled everywhere when the include list is empty", async () => {
      mockedYamlLoad.mockReturnValue(
        configWith({ includeChannelNamePatterns: [] }),
      );
      expect(
        await manager.isSmartReplyEligibleChannelName(
          "some-public-channel",
          "channel",
        ),
      ).toBe(false);
    });

    it("returns false when smartReply config is absent", async () => {
      mockedYamlLoad.mockReturnValue(configWith(undefined));
      expect(
        await manager.isSmartReplyEligibleChannelName(
          "some-public-channel",
          "channel",
        ),
      ).toBe(false);
    });

    it("returns false when the channel name is missing", async () => {
      mockedYamlLoad.mockReturnValue(
        configWith({ includeChannelNamePatterns: ["^team$"] }),
      );
      expect(
        await manager.isSmartReplyEligibleChannelName(undefined, "channel"),
      ).toBe(false);
    });

    it("returns false for direct messages", async () => {
      mockedYamlLoad.mockReturnValue(
        configWith({ includeChannelNamePatterns: [".*"] }),
      );
      expect(await manager.isSmartReplyEligibleChannelName("team", "im")).toBe(
        false,
      );
    });

    it('is eligible in every channel when include is [".*"]', async () => {
      mockedYamlLoad.mockReturnValue(
        configWith({ includeChannelNamePatterns: [".*"] }),
      );
      expect(
        await manager.isSmartReplyEligibleChannelName(
          "general-discussion",
          "channel",
        ),
      ).toBe(true);
    });

    it("is eligible in private channels the bot was added to", async () => {
      mockedYamlLoad.mockReturnValue(
        configWith({ includeChannelNamePatterns: [".*"] }),
      );
      expect(
        await manager.isSmartReplyEligibleChannelName("group-alpha", "group"),
      ).toBe(true);
    });

    it("restricts to the include list when one is configured", async () => {
      mockedYamlLoad.mockReturnValue(
        configWith({
          includeChannelNamePatterns: ["^project-"],
        }),
      );
      expect(
        await manager.isSmartReplyEligibleChannelName(
          "project-alpha",
          "channel",
        ),
      ).toBe(true);
      expect(
        await manager.isSmartReplyEligibleChannelName(
          "random-channel",
          "channel",
        ),
      ).toBe(false);
    });

    it("returns false for channels outside the include list", async () => {
      mockedYamlLoad.mockReturnValue(
        configWith({ includeChannelNamePatterns: ["^team$"] }),
      );
      expect(
        await manager.isSmartReplyEligibleChannelName(
          "random-channel",
          "channel",
        ),
      ).toBe(false);
    });

    it("returns true for channels on the include list", async () => {
      mockedYamlLoad.mockReturnValue(
        configWith({
          includeChannelNamePatterns: ["^private-team$", "^team$"],
        }),
      );
      expect(
        await manager.isSmartReplyEligibleChannelName("team", "channel"),
      ).toBe(true);
      expect(
        await manager.isSmartReplyEligibleChannelName("private-team", "group"),
      ).toBe(true);
    });
  });
});
