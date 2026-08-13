import { join } from "path";
import { randomUUID } from "crypto";
import { PersistentMap } from "./persistent-map";
import { config } from "./config";
import type { SlackChannelType } from "./types";

export interface ButtonMetadata {
  channel: string;
  channelType?: SlackChannelType;
  rootTs?: string;
  threadTs?: string;
  question?: string;
  answer?: string;
  text?: string;
  messageText?: string;
  chunkTs?: string[];
  originalQuestion?: string;
  originalAnswer?: string;
  originalRootTs?: string;
  createdAt: Date;
}

export class ButtonMetadataStore {
  private store: PersistentMap<ButtonMetadata>;

  constructor(filePath?: string) {
    this.store = new PersistentMap(
      filePath || join(config.persistDir, "button-metadata.json"),
    );
  }

  save(data: Omit<ButtonMetadata, "createdAt">): string {
    const ref = randomUUID();
    this.store.set(ref, { ...data, createdAt: new Date() });
    return ref;
  }

  lookup(ref: string): ButtonMetadata | undefined {
    return this.store.get(ref);
  }

  startCleanup(): void {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    setInterval(
      () => {
        const cutoff = Date.now() - SEVEN_DAYS_MS;
        for (const [key, entry] of this.store.entries()) {
          if (entry.createdAt.getTime() < cutoff) {
            this.store.delete(key);
          }
        }
      },
      60 * 60 * 1000,
    ).unref();
  }
}
