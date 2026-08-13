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

import { mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { PersistentMap } from "./persistent-map";

const TEST_DIR = "/tmp/persistent-map-test";

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("PersistentMap", () => {
  it("stores and retrieves values like a regular Map", () => {
    const map = new PersistentMap<{ name: string }>(
      join(TEST_DIR, "basic.json"),
    );
    map.set("a", { name: "alice" });
    map.set("b", { name: "bob" });

    expect(map.get("a")).toEqual({ name: "alice" });
    expect(map.get("b")).toEqual({ name: "bob" });
    expect(map.has("a")).toBe(true);
    expect(map.has("c")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("deletes entries", () => {
    const map = new PersistentMap<string>(join(TEST_DIR, "delete.json"));
    map.set("x", "val");
    expect(map.delete("x")).toBe(true);
    expect(map.has("x")).toBe(false);
    expect(map.delete("x")).toBe(false);
  });

  it("persists to disk and reloads on construction", () => {
    const filePath = join(TEST_DIR, "persist.json");

    const map1 = new PersistentMap<{ count: number }>(filePath, {
      debounceMs: 0,
    });
    map1.set("k1", { count: 1 });
    map1.set("k2", { count: 2 });
    map1.flushSync();

    const map2 = new PersistentMap<{ count: number }>(filePath);
    expect(map2.get("k1")).toEqual({ count: 1 });
    expect(map2.get("k2")).toEqual({ count: 2 });
    expect(map2.size).toBe(2);
  });

  it("round-trips Date values through serialisation", () => {
    const filePath = join(TEST_DIR, "dates.json");
    const now = new Date("2026-06-17T12:00:00.000Z");

    const map1 = new PersistentMap<{ createdAt: Date }>(filePath);
    map1.set("entry", { createdAt: now });
    map1.flushSync();

    const map2 = new PersistentMap<{ createdAt: Date }>(filePath);
    const loaded = map2.get("entry");
    expect(loaded).toBeDefined();
    expect(loaded!.createdAt).toBeInstanceOf(Date);
    expect(loaded!.createdAt.toISOString()).toBe("2026-06-17T12:00:00.000Z");
  });

  it("starts empty when the file does not exist", () => {
    const map = new PersistentMap<string>(
      join(TEST_DIR, "nonexistent", "nope.json"),
    );
    expect(map.size).toBe(0);
  });

  it("starts empty when the file contains invalid JSON", () => {
    const filePath = join(TEST_DIR, "bad.json");
    mkdirSync(TEST_DIR, { recursive: true });
    require("fs").writeFileSync(filePath, "not json{{{");

    const map = new PersistentMap<string>(filePath);
    expect(map.size).toBe(0);
  });

  it("creates parent directories on flush", () => {
    const filePath = join(TEST_DIR, "nested", "deep", "map.json");
    const map = new PersistentMap<string>(filePath);
    map.set("a", "b");
    map.flushSync();

    const raw = readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw)).toHaveProperty("a");
  });

  it("reflects deletions in the persisted file", () => {
    const filePath = join(TEST_DIR, "del-persist.json");
    const map = new PersistentMap<string>(filePath);
    map.set("keep", "yes");
    map.set("remove", "no");
    map.flushSync();

    map.delete("remove");
    map.flushSync();

    const map2 = new PersistentMap<string>(filePath);
    expect(map2.has("keep")).toBe(true);
    expect(map2.has("remove")).toBe(false);
  });

  it("supports iteration via entries() and for-of", () => {
    const map = new PersistentMap<number>(join(TEST_DIR, "iter.json"));
    map.set("a", 1);
    map.set("b", 2);

    const fromEntries = [...map.entries()];
    expect(fromEntries).toEqual(
      expect.arrayContaining([
        ["a", 1],
        ["b", 2],
      ]),
    );

    const fromForOf = [...map];
    expect(fromForOf).toEqual(fromEntries);
  });
});
