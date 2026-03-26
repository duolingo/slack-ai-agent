/**
 * Example approvable action — a minimal skeleton showing the pattern.
 *
 * Approvable actions are tools that require human confirmation before
 * executing. The bot posts a Slack confirmation dialog; execution only
 * happens after the user clicks Approve.
 *
 * To create your own:
 * 1. Copy this file and rename it (e.g. create-ticket.ts)
 * 2. Implement the ApprovableAction interface
 * 3. Export an instance as the default export
 * 4. The loader (src/approvable-actions/loader.ts) auto-discovers files
 *    in this directory (files prefixed with "example-" are skipped)
 *
 * See src/approvable-actions/types.ts for the full interface definition.
 */

import type {
  ApprovableAction,
  ActionSlackContext,
  ActionDependencies,
} from "../../src/approvable-actions/types";
import type { SlackBlock } from "../../src/types";
import { Logger } from "../../src/logger";

const logger = new Logger("ExampleAction");

export interface ExampleActionParams {
  title: string;
  description?: string;
}

export class ExampleAction implements ApprovableAction<ExampleActionParams> {
  name = "example_action";
  description = `An example approvable action. Use this as a template for building
your own human-in-the-loop actions. Replace this description with guidance for
when the AI agent should invoke this tool.`;

  private _inputSchema: Record<string, any> | null = null;

  get inputSchema(): Record<string, any> {
    if (!this._inputSchema) {
      // Return a Zod raw shape — a plain object whose keys are param names
      // and values are Zod validators. Do NOT wrap in zodToJsonSchema();
      // the SDK handles schema conversion internally.
      const z = require("zod");
      this._inputSchema = {
        title: z.string().describe("A short title for the action"),
        description: z
          .string()
          .optional()
          .describe("Optional detailed description"),
      };
    }
    return this._inputSchema;
  }

  /** Build the Slack confirmation message shown to the user. */
  async buildConfirmationBlocks(
    params: ExampleActionParams,
    _ctx: ActionSlackContext,
  ): Promise<SlackBlock[]> {
    const blocks: SlackBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Example Action*\n\n*Title:* ${params.title}`,
        },
      },
    ];
    if (params.description) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Description:*\n${params.description}`,
        },
      });
    }
    return blocks;
  }

  /** Execute the action after the user approves. */
  async execute(
    params: ExampleActionParams,
    ctx: ActionSlackContext,
    deps: ActionDependencies,
  ): Promise<void> {
    logger.info(`Executing example action: ${params.title}`);

    // Replace this with your actual logic — API call, MCP tool, etc.
    const result = `Action "${params.title}" executed successfully.`;

    // Optionally update the Slack confirmation message with results
    try {
      await deps.app.client.chat.update({
        channel: ctx.channel,
        ts: deps.confirmationMessageTs,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Example Action — Complete*\n\n*Title:* ${params.title}\n*Result:* ${result}`,
            },
          },
        ],
        text: result,
      });
    } catch (error) {
      logger.error("Failed to update confirmation message:", error);
    }
  }
}

export default new ExampleAction();
