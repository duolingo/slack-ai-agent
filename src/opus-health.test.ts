import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { OpusHealthMonitor, detectModelFallback } from "./opus-health";

const msg = (m: Record<string, unknown>): SDKMessage =>
  m as unknown as SDKMessage;

describe("detectModelFallback", () => {
  it("detects a model_fallback event and surfaces its trigger and models", () => {
    expect(
      detectModelFallback(
        msg({
          type: "system",
          subtype: "model_fallback",
          trigger: "overloaded",
          original_model: "claude-opus-5",
          fallback_model: "claude-sonnet-5",
        }),
      ),
    ).toMatchObject({
      trigger: "overloaded",
      originalModel: "claude-opus-5",
      fallbackModel: "claude-sonnet-5",
    });
  });

  it("ignores non-fallback messages", () => {
    expect(
      detectModelFallback(
        msg({ type: "system", subtype: "api_retry", error: "overloaded" }),
      ),
    ).toBeUndefined();
    expect(
      detectModelFallback(msg({ type: "assistant", error: "overloaded" })),
    ).toBeUndefined();
    expect(
      detectModelFallback(msg({ type: "result", subtype: "success" })),
    ).toBeUndefined();
  });
});

describe("OpusHealthMonitor", () => {
  const fallback = msg({
    type: "system",
    subtype: "model_fallback",
    trigger: "overloaded",
    original_model: "claude-opus-5",
    fallback_model: "claude-sonnet-5",
  });

  it("alerts with models/trigger in the message and the raw payload in the thread", () => {
    const notify = jest.fn();
    const monitor = new OpusHealthMonitor({ notify, now: () => 1000 });

    monitor.observe(fallback);

    expect(notify).toHaveBeenCalledTimes(1);
    const [text, threadDetail] = notify.mock.calls[0];
    expect(text).toContain("claude-opus-5");
    expect(text).toContain("claude-sonnet-5");
    expect(text).toContain("overloaded");
    expect(text).not.toContain("```"); // raw payload is not in the main message
    expect(threadDetail).toContain("model_fallback"); // raw payload goes to the thread
  });

  it("posts at most one alert per cooldown window", () => {
    const notify = jest.fn();
    let clock = 1000;
    const monitor = new OpusHealthMonitor({
      notify,
      now: () => clock,
      alertCooldownMs: 15 * 60 * 1000,
    });

    monitor.observe(fallback);
    clock += 14 * 60 * 1000; // still within the 15-minute window
    monitor.observe(fallback);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("alerts again once the cooldown has elapsed", () => {
    const notify = jest.fn();
    let clock = 1000;
    const monitor = new OpusHealthMonitor({
      notify,
      now: () => clock,
      alertCooldownMs: 15 * 60 * 1000,
    });

    monitor.observe(fallback);
    clock += 15 * 60 * 1000 + 1; // past the cooldown
    monitor.observe(fallback);

    expect(notify).toHaveBeenCalledTimes(2);
  });
});
