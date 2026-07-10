import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import { Logger } from "./logger";

const logger = new Logger("PersistentMap");

// Track all instances so we can flush on shutdown.
const allInstances: PersistentMap<unknown>[] = [];
let shutdownHooked = false;

const installShutdownHook = (): void => {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const flush = (signal: string) => {
    for (const map of allInstances) map.flushSync();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", () => flush("SIGTERM"));
  process.on("SIGINT", () => flush("SIGINT"));
};

/**
 * A Map backed by a JSON file on disk. Mutations are debounce-flushed so
 * the data survives process restarts (deploys) without hammering the FS.
 *
 * Dates are serialised as ISO strings under a `__date__` wrapper so they
 * round-trip correctly.
 */
export class PersistentMap<V> {
  private map: Map<string, V>;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(
    private readonly filePath: string,
    opts?: { debounceMs?: number },
  ) {
    this.debounceMs = opts?.debounceMs ?? 500;
    this.map = this.loadFromDisk();
    allInstances.push(this);
    installShutdownHook();
  }

  // ---- Map-compatible API ------------------------------------------------

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  set(key: string, value: V): this {
    this.map.set(key, value);
    this.scheduleSave();
    return this;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    const deleted = this.map.delete(key);
    if (deleted) this.scheduleSave();
    return deleted;
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.map.entries();
  }

  // ---- Persistence -------------------------------------------------------

  /** Force an immediate synchronous write (e.g. before process exit). */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeToDisk();
  }

  private scheduleSave(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writeToDisk();
    }, this.debounceMs);
  }

  private writeToDisk(): void {
    try {
      const obj: Record<string, V> = {};
      for (const [k, v] of this.map) {
        obj[k] = v;
      }
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(tagDates(obj), null, 2));
      renameSync(tmp, this.filePath);
    } catch (err) {
      logger.error("Failed to persist map", { filePath: this.filePath, err });
    }
  }

  private loadFromDisk(): Map<string, V> {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw, dateReviver) as Record<string, V>;
      logger.info("Loaded persistent map", {
        filePath: this.filePath,
        entries: Object.keys(parsed).length,
      });
      return new Map(Object.entries(parsed));
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        logger.warn("Failed to load persistent map, starting empty", {
          filePath: this.filePath,
          err,
        });
      }
      return new Map();
    }
  }
}

// ---- Date serialisation helpers ------------------------------------------
// Date.toJSON() fires before JSON.stringify's replacer, so we tag Dates
// in a pre-pass rather than relying on the replacer callback.

const DATE_TAG = "__date__";

const tagDates = (val: unknown): unknown => {
  if (val instanceof Date) return { [DATE_TAG]: val.toISOString() };
  if (Array.isArray(val)) return val.map(tagDates);
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = tagDates(v);
    }
    return out;
  }
  return val;
};

const dateReviver = (_key: string, value: unknown): unknown => {
  if (
    value !== null &&
    typeof value === "object" &&
    DATE_TAG in (value as Record<string, unknown>)
  ) {
    return new Date((value as Record<string, string>)[DATE_TAG]);
  }
  return value;
};
