// Provide dummy values for required env vars so config.ts loads without
// throwing — tests should never depend on real credentials.
process.env.CC_SLACK_BOT_TOKEN ??= "xoxb-test";
process.env.CC_SLACK_APP_TOKEN ??= "xapp-test";
process.env.CC_SLACK_SIGNING_SECRET ??= "test-signing-secret";
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test";
process.env.SLACK_WORKSPACE_URL ??= "https://test.slack.com";

// Silence console output during tests to keep output clean.
// This runs as a setupFile (before test framework), so we patch directly.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
