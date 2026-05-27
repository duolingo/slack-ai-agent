import { HAIKU_MODEL, resolveMode } from "./request-mode";

describe("resolveMode", () => {
  it("returns empty mode for plain text and no channel override", () => {
    expect(resolveMode("hello", undefined)).toEqual({});
    expect(resolveMode(undefined, undefined)).toEqual({});
  });

  it.each([
    ":duo-ai-bot-think:",
    "please think hard about this",
    "Think Hard",
    "I want you to TRY HARD",
  ])("maps %p to max effort", text => {
    expect(resolveMode(text, undefined)).toEqual({ effort: "max" });
  });

  it.each([":duo-ai-bot-fast:", "think fast for me", "THINK FAST"])(
    "maps %p to Haiku model",
    text => {
      expect(resolveMode(text, undefined)).toEqual({ model: HAIKU_MODEL });
    },
  );

  it("prefers fast over max when both phrases appear", () => {
    expect(resolveMode("think hard but also think fast", undefined)).toEqual({
      model: HAIKU_MODEL,
    });
  });

  it("falls back to channel mode when no trigger is present", () => {
    expect(resolveMode("normal question", { effort: "max" })).toEqual({
      effort: "max",
    });
    expect(resolveMode("normal question", { model: HAIKU_MODEL })).toEqual({
      model: HAIKU_MODEL,
    });
  });

  it("lets message triggers override channel defaults", () => {
    expect(resolveMode("think fast", { effort: "max" })).toEqual({
      model: HAIKU_MODEL,
    });
    expect(resolveMode("think hard", { model: "claude-opus-4-7" })).toEqual({
      model: "claude-opus-4-7",
      effort: "max",
    });
  });

  it("releases a channel Haiku pin when the message asks for max effort", () => {
    expect(resolveMode("think hard", { model: HAIKU_MODEL })).toEqual({
      effort: "max",
    });
  });

  it("drops a channel effort level that the channel-pinned Haiku model can't accept", () => {
    expect(resolveMode("hi", { model: HAIKU_MODEL, effort: "max" })).toEqual({
      model: HAIKU_MODEL,
    });
  });
});
