/**
 * Shared constants across the Slack app
 */

export const DEFAULT_EMAIL =
  process.env.DEFAULT_EMAIL || "unknown-user@example.com";

// Cache TTLs
export const CONTEXT_CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour
export const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const CHANNEL_PRIVACY_CACHE_TTL_MS = 1 * 24 * 60 * 60 * 1000; // 1 day, assuming private channel and public channels don't change often

// Slack API errors that are safe to skip when sending ephemeral messages
// (e.g. user left the channel, deactivated account)
export const SKIPPABLE_EPHEMERAL_ERRORS = new Set([
  "user_not_in_channel",
  "user_not_found",
  "account_inactive",
]);

// Logging truncation lengths
export const TOOL_CALL_PARAM_LOG_MAX_LENGTH = 200;
export const TOOL_RESPONSE_LOG_MAX_LENGTH = 300;
export const INCOMING_MESSAGE_LOG_MAX_LENGTH = 300;
export const RESPONSE_LOG_MAX_LENGTH = 1000;
export const TRACKING_FIELD_MAX_LENGTH = 1000;
