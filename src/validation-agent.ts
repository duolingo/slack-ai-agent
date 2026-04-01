/**
 * Sub-agent loader.
 *
 * Reads YAML definitions from config/subagents/ and returns them in the
 * format expected by the Claude Agent SDK's `options.agents` map.
 *
 * Each YAML file must have: name, description, model, prompt.
 * If the directory is empty or missing, no sub-agents are registered and
 * the bot continues to work normally.
 */

import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { Logger } from "./logger";

const logger = new Logger("SubAgents");

const SUBAGENTS_DIR = path.resolve("config/subagents");

interface SubagentDefinition {
  name: string;
  description: string;
  model: string;
  prompt: string;
}

/**
 * Load all sub-agent definitions from config/subagents/*.yaml.
 * Returns a map suitable for `options.agents` in the Claude Agent SDK.
 *
 * @param allowedTools - Optional tool allowlist to apply to all sub-agents.
 *   Ensures sub-agents have the same permissions as the parent agent.
 */
export function loadSubagentDefinitions(
  allowedTools?: string[],
): Record<string, unknown> {
  if (!fs.existsSync(SUBAGENTS_DIR)) return {};

  const files = fs
    .readdirSync(SUBAGENTS_DIR)
    .filter(
      f =>
        (f.endsWith(".yaml") || f.endsWith(".yml")) &&
        !f.startsWith("example-"),
    );

  const agents: Record<string, unknown> = {};

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(SUBAGENTS_DIR, file), "utf-8");
      const def = yaml.load(content) as SubagentDefinition;

      if (!def.name || !def.description || !def.prompt) {
        logger.warn(
          `Skipping ${file}: missing required fields (name, description, prompt)`,
        );
        continue;
      }

      const agent: Record<string, unknown> = {
        description: def.description,
        prompt: def.prompt,
        model: def.model || "sonnet",
      };

      if (allowedTools) {
        agent.tools = allowedTools;
      }

      agents[def.name] = agent;

      logger.info(`Loaded sub-agent: ${def.name} (from ${file})`);
    } catch (error) {
      logger.error(`Failed to load sub-agent from ${file}:`, error);
    }
  }

  return agents;
}
