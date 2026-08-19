// config is imported before tracing so dotenv.config() runs first to set environment variables.
import { config } from "./config";
import "./tracing";
import { App } from "@slack/bolt";
import { ClaudeHandler } from "./claude-handler";
import { SlackHandler } from "./slack-handler";
import { McpManager } from "./mcp-manager";
import { ReactionManager } from "./reaction-manager";
import { CustomActionRegistry, loadCustomActions } from "./custom-actions";
import { Logger } from "./logger";
import { UserUtils } from "./user-utils";
import { initTracking } from "./tracking";
import { ChannelConfigManager } from "./channel-config";
import { OpusHealthMonitor, buildSlackNotify } from "./opus-health";

const logger = new Logger("Main");

async function start() {
  try {
    logger.info("Starting Claude Code Slack app", {
      debug: config.debug,
    });

    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();
    const channelConfigManager = new ChannelConfigManager();
    channelConfigManager.setApp(app);
    initTracking(app, channelConfigManager);

    const reactionManager = new ReactionManager(app);

    const registry = new CustomActionRegistry(app, reactionManager);
    const actions = await loadCustomActions();
    for (const action of actions) {
      registry.register(action);
    }
    registry.setupButtonHandlers();
    registry.startSessionCleanup();

    const opusHealthMonitor = new OpusHealthMonitor({
      notify: buildSlackNotify(app, config.opsAlertChannelId),
    });

    const claudeHandler = new ClaudeHandler(
      mcpManager,
      registry,
      opusHealthMonitor,
    );
    const slackHandler = new SlackHandler(
      app,
      claudeHandler,
      reactionManager,
      channelConfigManager,
    );
    slackHandler.setupEventHandlers();

    // Setup Socket Mode monitoring
    const receiver = (app as any).receiver;
    if (receiver && typeof receiver.on === "function") {
      receiver.on("disconnect", (error: any) => {
        logger.error("🔌 Socket Mode disconnected!", error);
      });

      receiver.on("close", (code: number, reason: string) => {
        logger.error("🔌 Socket Mode connection closed", { code, reason });
      });

      receiver.on("outgoing_error", (error: any) => {
        logger.error("🔌 Socket Mode outgoing error", error);
      });

      receiver.on("incoming_error", (error: any) => {
        logger.error("🔌 Socket Mode incoming error", error);
      });

      logger.info("🔌 Socket Mode monitoring enabled", {
        socketMode: true,
        appToken: config.slack.appToken ? "present" : "missing",
      });
    } else {
      logger.info(
        "🔌 Socket Mode monitoring not available (receiver.on not supported)",
        {
          socketMode: true,
          appToken: config.slack.appToken ? "present" : "missing",
        },
      );
    }

    await app.start();
    UserUtils.startCleanupInterval();

    logger.info("⚡️ Claude Code Slack app is running!", {});
    logger.info("Configuration:", {
      debugMode: config.debug,
      baseDirectory: config.baseDirectory,
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
      customActions: actions.length,
    });
  } catch (error) {
    logger.error("Failed to start the bot", error);
    process.exit(1);
  }
}

start();
