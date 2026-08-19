import fs from "fs";
import os from "os";
import path from "path";
import {
  buildSandboxFilesystem,
  destroyThreadWorkspace,
  provisionThreadWorkspace,
} from "./config";

it("keeps workspace paths short enough for Linux sandbox sockets", () => {
  const sessionKey =
    "synthetic-user-identifier-synthetic-channel-identifier-1234567890.123456";
  const workspace = provisionThreadWorkspace(sessionKey);

  try {
    expect(workspace).toMatch(
      /^\/tmp\/slack-ai-agent\/workspaces\/[a-f0-9]{16}$/,
    );
    expect(path.join(workspace, ".tmp").length).toBeLessThan(60);
  } finally {
    destroyThreadWorkspace(sessionKey);
  }
});

it("allows Bash to access only the cwd and configured auth paths", () => {
  const originalEnv = process.env;
  const home = path.join(os.tmpdir(), "slack-ai-home-test");
  const homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(home);
  process.env = {
    ...process.env,
    CLOUDSDK_CONFIG: os.tmpdir(),
    GOOGLE_APPLICATION_CREDENTIALS: __filename,
  };
  try {
    const rules = buildSandboxFilesystem(__dirname);
    const paths = [__dirname, os.tmpdir(), __filename].map(target =>
      fs.realpathSync(target),
    );
    const mcpJwtHeadersFile = path.join(
      home,
      ".slack-ai-agent",
      "mcp-jwt-headers.json",
    );
    expect(rules.allowRead).toEqual([...paths, mcpJwtHeadersFile]);
    expect(rules.allowWrite).toEqual(rules.allowRead.slice(0, 2));
    expect(rules.denyWrite).toEqual([
      path.join(paths[0], ".claude"),
      path.join(paths[0], ".claude-state"),
    ]);
  } finally {
    homedirSpy.mockRestore();
    process.env = originalEnv;
  }
});

it("allows the default gcloud config when CLOUDSDK_CONFIG is unset", () => {
  const originalEnv = process.env;
  process.env = { ...process.env };
  delete process.env.CLOUDSDK_CONFIG;
  try {
    const rules = buildSandboxFilesystem(__dirname);
    const defaultCloudSdkConfig = path.join(os.homedir(), ".config", "gcloud");
    expect(rules.allowRead).toContain(defaultCloudSdkConfig);
    expect(rules.allowWrite).toContain(defaultCloudSdkConfig);
  } finally {
    process.env = originalEnv;
  }
});
