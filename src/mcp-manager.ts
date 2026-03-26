import * as fs from "fs";
import * as path from "path";
import { Logger } from "./logger";
import { CONTEXT_CACHE_TTL_MS } from "./constants";
import * as yaml from "js-yaml";

/**
 * Tool allowlist loaded from config/tool-allowlist.yaml.
 * Keys are role names listed in order of increasing privilege.
 * Each role inherits all tools from roles listed before it.
 * Adding a new role requires only a YAML change — no TypeScript updates.
 */
type ToolAllowlist = Record<string, string[]>;

interface ToolDenylist {
  disallowed_tools: string[];
}

export type McpStdioServerConfig = {
  type?: "stdio"; // Optional for backwards compatibility
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig;

export interface McpConfiguration {
  mcpServers: Record<string, McpServerConfig>;
}

export class McpManager {
  private logger = new Logger("McpManager");
  private config: McpConfiguration | null = null;
  private configPath: string;
  private allowlistCache: { data: ToolAllowlist; fetchedAt: number } | null =
    null;
  private denylistCache: {
    data: string[];
    fetchedAt: number;
    isError: boolean;
  } | null = null;
  private readonly CACHE_TTL_MS = CONTEXT_CACHE_TTL_MS;

  constructor(configPath: string = "./mcp-servers.json") {
    this.configPath = path.resolve(configPath);
  }

  loadConfiguration(): McpConfiguration | null {
    if (this.config) {
      return this.config;
    }

    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info("No MCP configuration file found", {
          path: this.configPath,
        });
        return null;
      }

      const configContent = fs.readFileSync(this.configPath, "utf-8");
      const parsedConfig = JSON.parse(configContent);

      if (
        !parsedConfig.mcpServers ||
        typeof parsedConfig.mcpServers !== "object"
      ) {
        this.logger.warn(
          "Invalid MCP configuration: missing or invalid mcpServers",
          { path: this.configPath },
        );
        return null;
      }

      // Validate server configurations
      for (const [serverName, serverConfig] of Object.entries(
        parsedConfig.mcpServers,
      )) {
        if (
          !this.validateServerConfig(
            serverName,
            serverConfig as McpServerConfig,
          )
        ) {
          this.logger.warn("Invalid server configuration, skipping", {
            serverName,
          });
          delete parsedConfig.mcpServers[serverName];
        }
      }

      this.config = parsedConfig as McpConfiguration;

      this.logger.info("Loaded MCP configuration", {
        path: this.configPath,
        serverCount: Object.keys(this.config.mcpServers).length,
        servers: Object.keys(this.config.mcpServers),
      });

      return this.config;
    } catch (error) {
      this.logger.error("Failed to load MCP configuration", error);
      return null;
    }
  }

  private validateServerConfig(
    serverName: string,
    config: McpServerConfig,
  ): boolean {
    if (!config || typeof config !== "object") {
      return false;
    }

    // Validate based on type
    if (!config.type || config.type === "stdio") {
      // Stdio server
      const stdioConfig = config as McpStdioServerConfig;
      if (!stdioConfig.command || typeof stdioConfig.command !== "string") {
        this.logger.warn("Stdio server missing command", { serverName });
        return false;
      }
    } else if (config.type === "sse" || config.type === "http") {
      // SSE or HTTP server
      const urlConfig = config as McpSSEServerConfig | McpHttpServerConfig;
      if (!urlConfig.url || typeof urlConfig.url !== "string") {
        this.logger.warn("SSE/HTTP server missing URL", {
          serverName,
          type: config.type,
        });
        return false;
      }
    } else {
      this.logger.warn("Unknown server type", {
        serverName,
        type: config.type,
      });
      return false;
    }

    return true;
  }

  getServerConfiguration(): Record<string, McpServerConfig> | undefined {
    const config = this.loadConfiguration();
    return config?.mcpServers;
  }

  /**
   * Load tool allowlist from local config file with caching
   */
  private async loadToolAllowlist(): Promise<ToolAllowlist> {
    const now = Date.now();

    if (
      this.allowlistCache &&
      now - this.allowlistCache.fetchedAt < this.CACHE_TTL_MS
    ) {
      return this.allowlistCache.data;
    }

    const allowlistContent = fs.readFileSync(
      path.resolve("config/tool-allowlist.yaml"),
      "utf-8",
    );
    const allowlist = yaml.load(allowlistContent) as ToolAllowlist;

    this.allowlistCache = { data: allowlist, fetchedAt: now };
    this.logger.debug("Loaded tool allowlist from local file");
    return allowlist;
  }

  /**
   * Get the highest (most privileged) role from the tool allowlist.
   * Returns undefined if no allowlist is configured.
   */
  async getHighestRole(): Promise<string | undefined> {
    const allowlist = await this.loadToolAllowlist();
    const hierarchy = Object.keys(allowlist);
    return hierarchy.length > 0 ? hierarchy[hierarchy.length - 1] : undefined;
  }

  /**
   * Get allowed tools for a user based on their role.
   * The role hierarchy is derived from the key order in tool-allowlist.yaml.
   * Tools accumulate: each role inherits all tools from roles listed before it.
   * Returns an empty array for "none" or unrecognized roles.
   */
  async getAllowedTools(role: string): Promise<string[]> {
    if (role === "none") {
      return [];
    }

    const allowlist = await this.loadToolAllowlist();
    const hierarchy = Object.keys(allowlist);
    if (hierarchy.length === 0) {
      return [];
    }

    const roleIndex = hierarchy.indexOf(role);
    if (roleIndex === -1) {
      this.logger.warn("Unknown role in tool allowlist, granting no tools", {
        role,
        available: hierarchy,
      });
      return [];
    }

    const tools: string[] = [];
    for (let i = 0; i <= roleIndex; i++) {
      const tierTools = allowlist[hierarchy[i]];
      if (tierTools) {
        tools.push(...tierTools);
      }
    }

    return tools;
  }

  // Retry loading denylist every 30s on error so fixes are picked up quickly
  private static readonly DENYLIST_ERROR_CACHE_TTL_MS = 30 * 1000;

  /**
   * Load tool denylist from local config file with caching.
   * Successful loads are cached for CACHE_TTL_MS (1 hour).
   * Errors are cached for DENYLIST_ERROR_CACHE_TTL_MS (30s) so fixes self-heal.
   */
  private loadToolDenylist(): string[] {
    const now = Date.now();

    if (this.denylistCache) {
      const ttl = this.denylistCache.isError
        ? McpManager.DENYLIST_ERROR_CACHE_TTL_MS
        : this.CACHE_TTL_MS;
      if (now - this.denylistCache.fetchedAt < ttl) {
        return this.denylistCache.data;
      }
    }

    const denylistPath = path.resolve("config/tool-denylist.yaml");
    if (!fs.existsSync(denylistPath)) {
      this.logger.warn(
        "No tool denylist file found — no tools will be blocked",
      );
      this.denylistCache = { data: [], fetchedAt: now, isError: true };
      return [];
    }

    let denylist: ToolDenylist;
    try {
      const denylistContent = fs.readFileSync(denylistPath, "utf-8");
      denylist = yaml.load(denylistContent) as ToolDenylist;
    } catch (error) {
      this.logger.warn(
        "Failed to read/parse tool denylist file — no tools will be blocked",
        error,
      );
      this.denylistCache = { data: [], fetchedAt: now, isError: true };
      return [];
    }

    if (
      !denylist?.disallowed_tools ||
      !Array.isArray(denylist.disallowed_tools) ||
      denylist.disallowed_tools.length === 0
    ) {
      this.logger.warn(
        "Tool denylist file exists but has no valid disallowed_tools entries — no tools will be blocked",
      );
      this.denylistCache = { data: [], fetchedAt: now, isError: true };
      return [];
    }

    const tools = denylist.disallowed_tools;
    this.denylistCache = { data: tools, fetchedAt: now, isError: false };
    this.logger.debug("Loaded tool denylist from local file");
    return tools;
  }

  /**
   * Get disallowed tools from the denylist config
   */
  getDisallowedTools(): string[] {
    return this.loadToolDenylist();
  }
}
