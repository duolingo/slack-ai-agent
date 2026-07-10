import { FABLE_MODEL, HAIKU_MODEL, resolveMode } from "./request-mode";

describe("resolveMode", () => {
  it("returns empty mode for plain text and no channel override", () => {
    expect(resolveMode("hello", undefined)).toEqual({});
    expect(resolveMode(undefined, undefined)).toEqual({});
  });

  it.each([
    "please think hard about this",
    "Think Hard",
    "I want you to TRY HARD",
  ])("maps %p to max effort", text => {
    expect(resolveMode(text, undefined)).toEqual({ effort: "max" });
  });

  it.each(["think fast for me", "THINK FAST"])(
    "maps %p to Haiku model",
    text => {
      expect(resolveMode(text, undefined)).toEqual({ model: HAIKU_MODEL });
    },
  );

  it.each([
    "think hardest about this",
    "please try hardest",
    "think harder for me",
    "TRY HARDER",
    "Think Dangerously",
  ])("maps %p to Fable model + max effort", text => {
    expect(resolveMode(text, undefined)).toEqual({
      model: FABLE_MODEL,
      effort: "max",
    });
  });

  describe("modeTriggerEmojis", () => {
    it("ignores an emoji shortcode when no trigger emoji is configured", () => {
      expect(resolveMode(":acme-bot-fast:", undefined)).toEqual({});
    });

    it("matches a configured fast-mode emoji", () => {
      expect(
        resolveMode(":acme-bot-fast:", undefined, undefined, {
          fast: ":acme-bot-fast:",
        }),
      ).toEqual({ model: HAIKU_MODEL });
    });

    it("matches a configured max-effort emoji", () => {
      expect(
        resolveMode(":acme-bot-think:", undefined, undefined, {
          think: ":acme-bot-think:",
        }),
      ).toEqual({ effort: "max" });
    });

    it("matches a configured Fable + max-effort emoji", () => {
      expect(
        resolveMode(":acme-bot-think-hardest:", undefined, undefined, {
          thinkHardest: ":acme-bot-think-hardest:",
        }),
      ).toEqual({ model: FABLE_MODEL, effort: "max" });
    });
  });

  it("fable trigger overrides a channel Haiku pin", () => {
    expect(resolveMode("think harder", { model: HAIKU_MODEL })).toEqual({
      model: FABLE_MODEL,
      effort: "max",
    });
  });

  it("fable trigger overrides channel effort", () => {
    expect(resolveMode("try hardest", { effort: "high" })).toEqual({
      model: FABLE_MODEL,
      effort: "max",
    });
  });

  it("prefers fast over fable when both phrases appear", () => {
    expect(resolveMode("think fast and think harder", undefined)).toEqual({
      model: HAIKU_MODEL,
    });
  });

  it("fable beats max-effort on substring overlap ('think harder' contains 'think hard')", () => {
    const result = resolveMode("think harder", undefined);
    expect(result.model).toBe(FABLE_MODEL);
    expect(result.effort).toBe("max");
  });

  it("plain 'think hard' still resolves to max effort without Fable", () => {
    const result = resolveMode("think hard", undefined);
    expect(result.model).toBeUndefined();
    expect(result.effort).toBe("max");
  });

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
    expect(resolveMode("think hard", { model: "claude-opus-4-8" })).toEqual({
      model: "claude-opus-4-8",
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

  it("activates fast mode with catch-all pattern on the default (Opus) model", () => {
    expect(resolveMode("hi", { fastModePattern: ".*" })).toEqual({
      fast: true,
    });
  });

  it("keeps fast mode alongside a channel effort level", () => {
    expect(resolveMode("hi", { effort: "max", fastModePattern: ".*" })).toEqual(
      {
        effort: "max",
        fast: true,
      },
    );
  });

  it("keeps fast mode when the channel pins an Opus model", () => {
    expect(
      resolveMode("hi", { model: "claude-opus-4-8", fastModePattern: ".*" }),
    ).toEqual({ model: "claude-opus-4-8", fast: true });
  });

  it("drops fast mode when the channel pins a non-Opus model", () => {
    expect(
      resolveMode("hi", { model: HAIKU_MODEL, fastModePattern: ".*" }),
    ).toEqual({
      model: HAIKU_MODEL,
    });
  });

  it("drops fast mode when a message trigger switches to a non-Opus model", () => {
    // "think fast" pins Haiku, which can't run Opus fast mode.
    expect(resolveMode("think fast", { fastModePattern: ".*" })).toEqual({
      model: HAIKU_MODEL,
    });
  });

  it("activates fast mode when fastModePattern matches", () => {
    expect(
      resolveMode("Urgency:* High", { fastModePattern: "Urgency:\\*? High" }),
    ).toEqual({ fast: true });
  });

  it("does not activate fast mode when fastModePattern does not match", () => {
    expect(
      resolveMode("Urgency:* Low", { fastModePattern: "Urgency:\\*? High" }),
    ).toEqual({});
  });

  it("activates fast mode via fastModeTagBot when explicitly mentioned", () => {
    expect(resolveMode("hi", { fastModeTagBot: true }, true)).toEqual({
      fast: true,
    });
  });

  it("does not activate fast mode via fastModeTagBot without mention", () => {
    expect(resolveMode("hi", { fastModeTagBot: true }, false)).toEqual({});
  });

  it("composes fastModePattern and fastModeTagBot via OR", () => {
    const channel = {
      fastModePattern: "Urgency:\\*? High",
      fastModeTagBot: true,
    };
    // Pattern matches, no mention → fast
    expect(resolveMode("Urgency:* High", channel, false)).toEqual({
      fast: true,
    });
    // No pattern match, but mentioned → fast
    expect(resolveMode("hi", channel, true)).toEqual({ fast: true });
    // Neither → no fast
    expect(resolveMode("hi", channel, false)).toEqual({});
  });
});
