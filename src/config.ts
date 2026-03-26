import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// The Claude Agent SDK's working directory lives under /tmp so the agent
// never reads from or writes to the application directory.  We copy
// .claude/ and data/ into it so skills, settings, and employee data are
// physically inside the sandbox (symlinks get resolved to the real path
// which is outside the sandbox, causing security blocks on grep/Read/Glob).
const BASE_DIR = "/tmp/slack-ai-agent";

/** Replace dest with a fresh copy of source. Copies to a temp dir first
 *  so the sandbox keeps its old copy if the source read fails. */
function copyDirIntoSandbox(source: string, dest: string): void {
  if (!fs.existsSync(source)) return;
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(source, tmp, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

// How often to re-sync data/ from source so the sandbox stays current.
const DATA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

function ensureBaseDirectory(): string {
  fs.mkdirSync(BASE_DIR, { recursive: true });

  // Copy .claude/ so skills and project settings are discovered.
  copyDirIntoSandbox(path.resolve(".claude"), path.join(BASE_DIR, ".claude"));

  // Copy data/ so the agent and sub-agents can read employees.yaml.
  // Non-fatal: if an external sync job is rotating the file at this moment,
  // cpSync can hit ENOENT. The periodic refresh will pick it up later.
  try {
    copyDirIntoSandbox(path.resolve("data"), path.join(BASE_DIR, "data"));
  } catch {
    // Bot can start without employee data — users are treated as non-employee.
  }

  // Re-sync data/ periodically so the sandbox copy of employees.yaml stays
  // current as external sync jobs update the source file.
  // .unref() prevents the interval from blocking process exit.
  setInterval(() => {
    try {
      copyDirIntoSandbox(path.resolve("data"), path.join(BASE_DIR, "data"));
    } catch {
      // Non-fatal — sandbox keeps its previous copy until the next sync.
    }
  }, DATA_REFRESH_INTERVAL_MS).unref();

  return BASE_DIR;
}

export const config = {
  slack: {
    botToken: getRequiredEnv("CC_SLACK_BOT_TOKEN"),
    appToken: getRequiredEnv("CC_SLACK_APP_TOKEN"),
    signingSecret: getRequiredEnv("CC_SLACK_SIGNING_SECRET"),
  },
  anthropic: {
    apiKey: getRequiredEnv("ANTHROPIC_API_KEY"),
    model: "claude-opus-4-6", // Claude 4.6 Opus - most capable model
  },
  slackWorkspaceUrl: getRequiredEnv("SLACK_WORKSPACE_URL"),
  baseDirectory: ensureBaseDirectory(),
  debug: process.env.DEBUG === "true" || process.env.NODE_ENV === "development",
};
