/**
 * Dynamic loader for approvable actions.
 *
 * Scans config/approvable-actions/ for TypeScript files, dynamically imports
 * each one, and returns the actions to register. Each file must default-export
 * an ApprovableAction instance.
 *
 * If the directory is empty or missing, returns an empty array and the bot
 * continues to work normally (just without approvable actions).
 */

import fs from "fs";
import path from "path";
import { Logger } from "../logger";
import type { ApprovableAction } from "./types";

const logger = new Logger("ApprovableActions");

// Detect whether we're running from compiled JS (production) or TypeScript (dev)
const isCompiled = __filename.endsWith(".js");

// In compiled mode, config files live at dist/config/approvable-actions/ relative
// to this file at dist/src/approvable-actions/loader.js.
// In dev mode, config files live at config/approvable-actions/ relative to CWD.
const ACTIONS_DIR = isCompiled
  ? path.resolve(__dirname, "../../config/approvable-actions")
  : path.resolve("config/approvable-actions");

const CONFIG_EXT = isCompiled ? ".js" : ".ts";

/**
 * Discover and load all approvable action files from config/approvable-actions/.
 * Files that default-export an ApprovableAction instance are registered.
 * Files without a valid default export (e.g. utility modules) are silently skipped.
 */
export const loadApprovableActions = async (): Promise<
  ApprovableAction<any>[]
> => {
  if (!fs.existsSync(ACTIONS_DIR)) {
    return [];
  }

  const files = fs
    .readdirSync(ACTIONS_DIR)
    .filter(
      f =>
        f.endsWith(CONFIG_EXT) &&
        !f.endsWith(".d.ts") &&
        !f.startsWith("example-"),
    );

  if (files.length === 0) {
    return [];
  }

  const actions: ApprovableAction<any>[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(ACTIONS_DIR, file);
      const mod = await import(filePath);
      const action = mod.default;

      // Silently skip files without a valid ApprovableAction default export
      // (e.g. utility modules like temporal-utils.ts)
      if (!action || !action.name || !action.execute) {
        continue;
      }

      actions.push(action);
      logger.info(`Loaded approvable action: ${action.name} (from ${file})`);
    } catch (error) {
      logger.error(`Failed to load approvable action from ${file}:`, error);
    }
  }

  return actions;
};
