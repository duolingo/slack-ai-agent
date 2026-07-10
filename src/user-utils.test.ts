import { redactChannelName } from "./user-utils";

describe("redactChannelName", () => {
  it("returns the real name when full logging is allowed", () => {
    expect(redactChannelName("general", "channel", true)).toBe("general");
  });

  it("labels private channels as private-channel", () => {
    expect(redactChannelName("secret-channel", "group", false)).toBe(
      "private-channel",
    );
  });

  it("labels DMs as direct-message", () => {
    expect(redactChannelName(undefined, "im", false)).toBe("direct-message");
  });

  it("labels group DMs as group-dm", () => {
    expect(redactChannelName(undefined, "mpim", false)).toBe("group-dm");
  });
});
