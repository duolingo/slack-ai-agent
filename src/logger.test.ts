import { truncateForLog, withMessageId, getMessageId } from "./logger";

describe("truncateForLog", () => {
  it("returns empty string for null/undefined", () => {
    expect(truncateForLog(null, 100)).toBe("");
    expect(truncateForLog(undefined, 100)).toBe("");
    expect(truncateForLog("", 100)).toBe("");
  });

  it("collapses whitespace to single spaces", () => {
    expect(truncateForLog("hello   world", 100)).toBe("hello world");
    expect(truncateForLog("hello\n\nworld", 100)).toBe("hello world");
    expect(truncateForLog("hello\t\tworld", 100)).toBe("hello world");
  });

  it("returns collapsed text when within limit", () => {
    expect(truncateForLog("hello world", 20)).toBe("hello world");
  });

  it("truncates with ellipsis when over limit", () => {
    expect(truncateForLog("hello world", 8)).toBe("hello wo...");
  });

  it("collapses then truncates", () => {
    expect(truncateForLog("hello   world   foo", 12)).toBe("hello world ...");
  });
});

describe("withMessageId / getMessageId", () => {
  it("returns undefined when no context is set", () => {
    expect(getMessageId()).toBeUndefined();
  });

  it("provides messageId within callback", () => {
    withMessageId("test-123", () => {
      expect(getMessageId()).toBe("test-123");
    });
  });

  it("returns undefined after callback completes", () => {
    withMessageId("test-123", () => {});
    expect(getMessageId()).toBeUndefined();
  });

  it("works with async callbacks", async () => {
    await withMessageId("async-456", async () => {
      await Promise.resolve();
      expect(getMessageId()).toBe("async-456");
    });
  });

  it("supports nested contexts", () => {
    withMessageId("outer", () => {
      expect(getMessageId()).toBe("outer");
      withMessageId("inner", () => {
        expect(getMessageId()).toBe("inner");
      });
      expect(getMessageId()).toBe("outer");
    });
  });
});
