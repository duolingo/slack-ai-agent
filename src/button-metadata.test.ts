jest.mock("./config", () => ({
  config: {
    slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "s" },
    anthropic: { apiKey: "test-key", model: "claude-opus-4-8" },
    slackWorkspaceUrl: "https://test.slack.com",
    baseDirectory: "/tmp/test",
    persistDir: "/tmp/test-persist",
    debug: false,
  },
}));

import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { ButtonMetadataStore } from "./button-metadata";

const TEST_DIR = "/tmp/button-metadata-test";

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ButtonMetadataStore", () => {
  it("save returns a unique ref and lookup retrieves the data", () => {
    const store = new ButtonMetadataStore(join(TEST_DIR, "meta.json"));
    const ref = store.save({
      channel: "C123",
      question: "hello",
      answer: "world",
    });
    expect(typeof ref).toBe("string");
    expect(ref.length).toBeGreaterThan(0);

    const data = store.lookup(ref);
    expect(data?.channel).toBe("C123");
    expect(data?.question).toBe("hello");
    expect(data?.answer).toBe("world");
    expect(data?.createdAt).toBeInstanceOf(Date);
  });

  it("returns undefined for unknown refs", () => {
    const store = new ButtonMetadataStore(join(TEST_DIR, "meta2.json"));
    expect(store.lookup("nonexistent")).toBeUndefined();
  });

  it("stores arbitrarily long text without truncation", () => {
    const store = new ButtonMetadataStore(join(TEST_DIR, "meta3.json"));
    const longText = "x".repeat(10000);
    const ref = store.save({ channel: "C1", question: longText });
    expect(store.lookup(ref)?.question).toBe(longText);
  });

  it("generates distinct refs for each save", () => {
    const store = new ButtonMetadataStore(join(TEST_DIR, "meta4.json"));
    const ref1 = store.save({ channel: "C1" });
    const ref2 = store.save({ channel: "C1" });
    expect(ref1).not.toBe(ref2);
  });
});
