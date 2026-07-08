import { isFullContentLoggingAllowed, initTracking } from "./tracking";
import { ChannelConfigManager } from "./channel-config";

// Initialize tracking with a ChannelConfigManager that reads from config/channels.yaml
const configManager = new ChannelConfigManager();
initTracking(null as any, configManager);

describe("isFullContentLoggingAllowed", () => {
  it("returns true for an allowlisted private channel", async () => {
    const allowlist = await configManager.getFullContentLoggingAllowlist();
    const allowlistedChannelId = [...allowlist][0];
    // Skip if no channels are configured in the allowlist
    if (!allowlistedChannelId) return;
    // "group" is the Slack channel_type for private channels
    const result = await isFullContentLoggingAllowed(
      allowlistedChannelId,
      "group",
    );
    expect(result).toBe(true);
  });

  it("returns false when channelId is empty", async () => {
    const result = await isFullContentLoggingAllowed("", "channel");
    expect(result).toBe(false);
  });

  it("returns false for a non-allowlisted DM", async () => {
    const result = await isFullContentLoggingAllowed("D99999999", "im");
    expect(result).toBe(false);
  });
});
