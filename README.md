# Slack AI Agent

A Slack bot powered by Claude Code SDK. Responds in DMs, channels, and @-mentions with streaming responses, thread context, file uploads, and extensible MCP tool integrations.

## Architecture

- **`src/slack-handler.ts`** - Message routing and event handling
- **`src/claude-handler.ts`** - Session management and Claude Code SDK integration
- **`src/mcp-manager.ts`** - MCP server configuration and tool management
- **`src/message-processor.ts`** - Stream processing and response formatting
- **`src/tracking.ts`** - Analytics tracking for message processing and feedback
- **`src/channel-config.ts`** - Channel-specific context and configuration management
- **`src/user-utils.ts`** - User information and role-based access control

## Setup

### 1. Install

```bash
git clone <your-repo>
npm install
```

### 2. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → "Create New App" → "From an app manifest"
2. Paste the contents of `slack-app-manifest.yaml`
3. Install the app to your workspace
4. Copy the **Bot User OAuth Token** (`xoxb-...`) from "OAuth & Permissions"
5. Generate an **App-Level Token** with `connections:write` scope (`xapp-...`) from "Basic Information"
6. Copy the **Signing Secret** from "Basic Information"

### 3. Configure Environment

```bash
cp .env.example .env
```

Fill in your tokens. See `.env.example` for all available variables.

### 4. Configure the Bot

Copy the example configs and customize for your workspace:

#### Required

| Example file                                      | Copy to                                   | Purpose                                                     |
| ------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `config/example-reactions.yaml`                   | `config/reactions.yaml`                   | Emoji reactions for thinking, completion, errors            |
| `config/example-tool-allowlist.yaml`              | `config/tool-allowlist.yaml`              | Role-based tool access control (key order = role hierarchy) |
| `config/example-tool-denylist.yaml`               | `config/tool-denylist.yaml`               | Tools the bot must never use                                |
| `config/instructions/example-general-context.txt` | `config/instructions/general-context.txt` | Base system prompt injected into every response             |

#### Optional

| Example file                                             | Copy to                               | Purpose                                                                |
| -------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `config/example-channels.yaml`                           | `config/channels.yaml`                | Channel auto-reply routing, keyword triggers, ephemeral summaries      |
| `config/instructions/example-channel.txt`                | `config/instructions/<name>.txt`      | Channel-specific system prompt context (referenced by `channels.yaml`) |
| `config/subagents/example-subagents.yaml`                | `config/subagents/<name>.yaml`        | Sub-agents for validation or post-processing                           |
| `config/approvable-actions/example-approvable-action.ts` | `config/approvable-actions/<name>.ts` | Human-in-the-loop actions (auto-discovered)                            |
| `data/example-employees.yaml`                            | `data/employees.yaml`                 | Employee directory for role assignment and people lookups              |
| `mcp-servers.example.json`                               | `mcp-servers.json`                    | MCP server connections (GitHub, Slack, Jenkins, etc.)                  |

Quick start:

```bash
cp .env.example .env
cp config/example-reactions.yaml config/reactions.yaml
cp config/example-tool-allowlist.yaml config/tool-allowlist.yaml
cp config/example-tool-denylist.yaml config/tool-denylist.yaml
cp config/instructions/example-general-context.txt config/instructions/general-context.txt
```

### 5. Run

```bash
npm run dev    # development (auto-reload)
npm run build && npm run prod  # production
```

## Usage

- **DMs**: responds to all messages
- **Configured channels**: auto-replies based on `channels.yaml` rules
- **All other channels**: responds only when @-mentioned
- **File uploads**: supports images, code files, PDFs, and documents

## Testing

```bash
npm test              # run all tests
npx jest --watch      # re-run on file changes
npx jest src/logger   # run tests matching a pattern
```

Tests use [Jest](https://jestjs.io/) with `ts-jest`. Test files live next to their source files as `*.test.ts`.

## License

Apache 2.0 — see [LICENSE](LICENSE).

Duolingo is hiring! Apply at https://www.duolingo.com/careers
