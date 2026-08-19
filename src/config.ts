import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { OPUS_MODEL } from "./request-mode";

dotenv.config();

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// The Claude Agent SDK's working directory lives under /tmp so the agent
// never reads from or writes to the application directory.  Each Slack
// thread gets its own subdirectory under workspaces/ with curated skills and
// data physically inside the sandbox.
export const SANDBOX_ROOT = "/tmp/slack-ai-agent";
const WORKSPACES_DIR = path.join(SANDBOX_ROOT, "workspaces");

// Linux sandbox bridge sockets have a short path limit, so workspace names
// must leave enough room for socket filenames under the workspace temp dir.
const threadWorkspace = (sessionKey: string): string =>
  path.join(
    WORKSPACES_DIR,
    crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 16),
  );

/** Replace dest with a fresh copy of source. Copies to a temp dir first
 *  so the sandbox keeps its old copy if the source read fails. */
function copyDirIntoSandbox(source: string, dest: string): void {
  if (!fs.existsSync(source)) return;
  const tmp = `${dest}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(source, tmp, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

// How often to re-sync data/ from source so thread workspaces stay current.
const DATA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

function refreshAllWorkspaceData(): void {
  if (!fs.existsSync(WORKSPACES_DIR)) return;
  for (const name of fs.readdirSync(WORKSPACES_DIR)) {
    const workspace = path.join(WORKSPACES_DIR, name);
    try {
      if (!fs.statSync(workspace).isDirectory()) continue;
      copyDirIntoSandbox(path.resolve("data"), path.join(workspace, "data"));
    } catch {
      // Non-fatal — workspace keeps its previous copy until the next sync.
    }
  }
}

function ensureSandboxRoot(): string {
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  // Re-sync data/ in every active thread workspace periodically so
  // employees.yaml stays current as external sync jobs update the source.
  // .unref() prevents the interval from blocking process exit.
  setInterval(refreshAllWorkspaceData, DATA_REFRESH_INTERVAL_MS).unref();

  return SANDBOX_ROOT;
}

/** Create or refresh the per-thread agent workspace for a Slack session. */
export function provisionThreadWorkspace(sessionKey: string): string {
  const workspace = threadWorkspace(sessionKey);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, ".tmp"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".claude-state"), { recursive: true });
  const claudeDir = path.join(workspace, ".claude");
  fs.rmSync(claudeDir, { recursive: true, force: true });
  copyDirIntoSandbox(
    path.resolve(".claude/skills"),
    path.join(claudeDir, "skills"),
  );
  try {
    copyDirIntoSandbox(path.resolve("data"), path.join(workspace, "data"));
  } catch {
    // Bot can serve the thread without employee data — users are non-employee.
  }
  return workspace;
}

/** Remove a thread workspace when its session is evicted. */
export function destroyThreadWorkspace(sessionKey: string): void {
  fs.rmSync(threadWorkspace(sessionKey), {
    recursive: true,
    force: true,
  });
}

const resolvedPaths = (...paths: Array<string | undefined>): string[] =>
  paths.flatMap(value =>
    value
      ? [fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value)]
      : [],
  );

export const getCloudSdkConfig = (): string =>
  process.env.CLOUDSDK_CONFIG || path.join(os.homedir(), ".config", "gcloud");

const getMcpJwtHeadersFile = (): string =>
  path.join(os.homedir(), ".slack-ai-agent", "mcp-jwt-headers.json");

/** Bash can access the cwd and the explicitly configured auth paths. */
export const buildSandboxFilesystem = (workingDirectory: string) => {
  return {
    denyRead: resolvedPaths(
      os.homedir(),
      path.resolve("."),
      path.dirname(SANDBOX_ROOT),
      os.tmpdir(),
    ),
    allowRead: resolvedPaths(
      workingDirectory,
      getCloudSdkConfig(),
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      getMcpJwtHeadersFile(),
    ),
    allowWrite: resolvedPaths(workingDirectory, getCloudSdkConfig()),
    denyWrite: resolvedPaths(
      path.join(workingDirectory, ".claude"),
      path.join(workingDirectory, ".claude-state"),
    ),
  };
};

/**
 * Network rules for the Bash sandbox. Adds the Google Cloud and AWS endpoints
 * the data-skill CLIs need on top of the SDK's managed domains.
 */
export const SANDBOX_NETWORK = {
  allowedDomains: ["*.googleapis.com", "*.amazonaws.com", "169.254.169.254"],
};

export const config = {
  slack: {
    botToken: getRequiredEnv("CC_SLACK_BOT_TOKEN"),
    appToken: getRequiredEnv("CC_SLACK_APP_TOKEN"),
    signingSecret: getRequiredEnv("CC_SLACK_SIGNING_SECRET"),
  },
  anthropic: {
    apiKey: (() => {
      if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
      if (process.env.ANTHROPIC_AUTH_TOKEN) {
        if (!process.env.ANTHROPIC_BASE_URL) {
          throw new Error(
            "ANTHROPIC_BASE_URL is required when using ANTHROPIC_AUTH_TOKEN",
          );
        }
        return process.env.ANTHROPIC_AUTH_TOKEN;
      }
      throw new Error(
        "Missing required environment variable: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL",
      );
    })(),
    model: OPUS_MODEL, // Claude Opus 5 - most capable model
  },
  slackWorkspaceUrl: getRequiredEnv("SLACK_WORKSPACE_URL"),
  // Optional Slack channel for operational alerts (e.g. model fallback). When
  // unset, no ops notifications are sent. Set OPS_ALERT_CHANNEL_ID in the
  // deployment environment to enable them.
  opsAlertChannelId: process.env.OPS_ALERT_CHANNEL_ID || undefined,
  trackingClientId: process.env.TRACKING_CLIENT_ID || "slack-ai-agent",
  baseDirectory: ensureSandboxRoot(),
  // Persistent state that must survive process restarts (deploys).
  // Defaults to a .persist/ directory in the app root — NOT under /tmp.
  persistDir: process.env.PERSIST_DIR || path.resolve(".persist"),
  debug: process.env.DEBUG === "true" || process.env.NODE_ENV === "development",
};
