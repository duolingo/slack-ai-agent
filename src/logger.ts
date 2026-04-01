import { AsyncLocalStorage } from "async_hooks";
import { config } from "./config";

/**
 * Request context for propagating messageId through async call chains
 */
interface RequestContext {
  messageId?: string;
}

// Global async local storage for request context
const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function with a messageId context that propagates to all nested async calls
 */
export function withMessageId<T>(
  messageId: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return requestContext.run({ messageId }, fn);
}

/**
 * Get the current messageId from context (if set)
 */
export function getMessageId(): string | undefined {
  return requestContext.getStore()?.messageId;
}

/** Truncate string and collapse whitespace to single line */
export const truncateForLog = (
  str: string | undefined | null,
  maxLen: number,
): string => {
  if (!str) return "";
  const collapsed = str.replace(/\s+/g, " ");
  return collapsed.length > maxLen
    ? collapsed.substring(0, maxLen) + "..."
    : collapsed;
};

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private format(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const msgId = getMessageId();
    const msgIdPrefix = msgId ? `[${msgId}] ` : "";
    const prefix = `[${timestamp}] [${level}] [${this.context}]`;
    if (!data) return `${prefix} ${msgIdPrefix}${message}`;
    try {
      return `${prefix} ${msgIdPrefix}${message} ${JSON.stringify(data)}`;
    } catch {
      return `${prefix} ${msgIdPrefix}${message} [Unstringifiable]`;
    }
  }

  debug(message: string, data?: any) {
    if (config.debug) console.log(this.format("DEBUG", message, data));
  }

  info(message: string, data?: any) {
    console.log(this.format("INFO", message, data));
  }

  /**
   * Log with privacy-aware content handling.
   * @param message - Log message prefix
   * @param safeData - Data that is always safe to log (counts, lengths, etc)
   * @param sensitiveContent - Content that should be hidden when !allowFullLogging
   * @param allowFullLogging - Whether to show sensitive content or "[hidden]"
   */
  infoSensitive(
    message: string,
    safeData: Record<string, unknown>,
    sensitiveContent: string | undefined,
    allowFullLogging: boolean,
  ) {
    const data = {
      ...safeData,
      content: allowFullLogging ? sensitiveContent : "[hidden]",
    };
    console.log(this.format("INFO", message, data));
  }

  warn(message: string, data?: any) {
    console.warn(this.format("WARN", message, data));
  }

  error(message: string, error?: any) {
    const errorData =
      error instanceof Error
        ? { errorMessage: error.message, stack: error.stack, ...error }
        : error;
    console.error(this.format("ERROR", message, errorData));
  }
}
