import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { App } from "@slack/bolt";
import { Logger } from "./logger";

export interface ModelFallbackEvent {
  /** The cause the SDK names for the fallback, if any (e.g. "overloaded"). */
  trigger?: string;
  /** The primary model that was switched away from, if named. */
  originalModel?: string;
  /** The model the request fell back to, if named. */
  fallbackModel?: string;
  /** The full raw event, included verbatim in the alert. */
  raw: Record<string, unknown>;
}

/**
 * Detect the agent SDK's `model_fallback` system event — the authoritative
 * signal that the primary model was switched off (overloaded or unavailable)
 * and the request is now served by `fallbackModel`. The SDK emits this as a
 * stream message, not a thrown error.
 *
 * We intentionally don't classify the cause: a `model_fallback` event means a
 * real switch happened, which is exactly what's worth reporting. In production
 * the primary is a valid Opus, so it only fires when Opus is genuinely degraded.
 * The event's own fields (including any `trigger`) are reported as-is.
 */
export const detectModelFallback = (
  message: SDKMessage,
): ModelFallbackEvent | undefined => {
  const m = message as any;
  if (m?.type !== "system" || m?.subtype !== "model_fallback") return undefined;
  return {
    trigger: m.trigger ?? m.error ?? m.reason,
    originalModel: m.original_model ?? m.from_model,
    fallbackModel: m.fallback_model ?? m.to_model,
    raw: m,
  };
};

export interface OpusHealthMonitorOptions {
  /**
   * Posts an alert to the ops channel. `threadDetail` (the raw event payload)
   * should be posted as a threaded reply under the main `message`. Omitted
   * (no-op) when no channel is configured.
   */
  notify?: (message: string, threadDetail?: string) => void;
  /** Minimum gap between fallback alerts, to avoid spamming the channel during an outage. */
  alertCooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Default minimum gap between fallback alerts (15 minutes). */
export const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

const logger = new Logger("OpusHealthMonitor");

/**
 * Observes the message stream of Opus requests and emits a throttled ops-channel
 * alert when the SDK falls back off Opus. It does not change model selection —
 * the SDK's `fallbackModel` option transparently serves the request on Sonnet
 * and re-tries Opus on each new turn. This monitor only provides visibility into
 * when that fallback is happening.
 */
export class OpusHealthMonitor {
  private readonly notify?: (message: string, threadDetail?: string) => void;
  private readonly alertCooldownMs: number;
  private readonly now: () => number;
  private lastAlertAt = 0;

  constructor(options: OpusHealthMonitorOptions = {}) {
    this.notify = options.notify;
    this.alertCooldownMs = options.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Observe one streamed message from an Opus request. When it's a
   * `model_fallback` event, log it and emit a throttled ops alert — at most one
   * per cooldown window (default 15 minutes).
   */
  observe(message: SDKMessage): void {
    const event = detectModelFallback(message);
    if (!event) return;

    logger.warn("Primary model fell back", {
      trigger: event.trigger,
      originalModel: event.originalModel,
      fallbackModel: event.fallbackModel,
    });

    const now = this.now();
    if (this.lastAlertAt !== 0 && now - this.lastAlertAt < this.alertCooldownMs)
      return;
    this.lastAlertAt = now;

    this.notify?.(formatFallbackAlert(event), formatFallbackDetail(event));
  }
}

/** Build the headline Slack alert text for a model-fallback event. */
const formatFallbackAlert = (event: ModelFallbackEvent): string => {
  const from = event.originalModel ?? "the primary model";
  const to = event.fallbackModel ?? "a fallback model";
  const triggerText = event.trigger ? ` — trigger: \`${event.trigger}\`` : "";
  return (
    `:warning: *Model fell back*: \`${from}\` → \`${to}\`${triggerText}. ` +
    "The SDK re-tries the primary model on each new turn, so this clears on its own when it recovers."
  );
};

/** The raw event payload, posted as a threaded reply under the alert. */
const formatFallbackDetail = (event: ModelFallbackEvent): string =>
  `\`\`\`${JSON.stringify(event.raw)}\`\`\``;

/**
 * Build a notify callback that posts to a Slack channel with the raw payload
 * as a threaded reply. Returns undefined when no channel is configured.
 */
export const buildSlackNotify = (
  app: App,
  channelId: string | undefined,
): ((message: string, threadDetail?: string) => void) | undefined => {
  if (!channelId) return undefined;
  return (text: string, threadDetail?: string) => {
    void app.client.chat
      .postMessage({ channel: channelId, text, unfurl_links: false })
      .then((res: { ts?: string }) => {
        if (threadDetail && res.ts) {
          return app.client.chat.postMessage({
            channel: channelId,
            thread_ts: res.ts,
            text: threadDetail,
          });
        }
        return undefined;
      })
      .catch((err: unknown) =>
        logger.error("Failed to post Opus health alert", { err }),
      );
  };
};
