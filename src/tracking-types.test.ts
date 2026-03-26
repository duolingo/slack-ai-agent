import { generateMessageId, truncateText } from "./tracking-types";

describe("generateMessageId", () => {
  it("creates ID from channel and messageTs", () => {
    const id = generateMessageId("C12345678", "1234567890.123456");
    expect(id).toBe("5678-3456");
  });

  it("uses channel-only fallback when messageTs is missing", () => {
    const id = generateMessageId("C12345678");
    expect(id).toBe("5678-xxxx");
  });

  it("uses timestamp fallback when both are missing", () => {
    const id = generateMessageId();
    expect(id).toMatch(/^msg-\d{6}$/);
  });

  it("handles short channel IDs", () => {
    const id = generateMessageId("C1", "1.2");
    expect(id).toBe("C1-12");
  });
});

describe("truncateText", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });

  it("returns text unchanged when exactly at limit", () => {
    expect(truncateText("hello", 5)).toBe("hello");
  });

  it("truncates with ellipsis when over limit", () => {
    expect(truncateText("hello world", 8)).toBe("hello...");
  });

  it("handles very short maxLength", () => {
    expect(truncateText("hello", 4)).toBe("h...");
  });

  it("handles empty string", () => {
    expect(truncateText("", 10)).toBe("");
  });
});
