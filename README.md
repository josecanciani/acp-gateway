# acp-gateway

A lightweight TypeScript gateway that exposes OpenAI-compatible `/v1/chat/completions` endpoints and routes requests to [Agent Client Protocol](https://agentclientprotocol.org/) (ACP) agents like Devin and Kimi. Each request spawns a fresh agent CLI process, communicates over stdio using the ACP protocol, and kills the process when the response completes. Supports streaming (SSE) and non-streaming responses, pluggable adapters, and automatic permission handling.

## Features

- **OpenAI-compatible API** — drop-in replacement for `/v1/chat/completions` and `/v1/models`
- **Streaming (SSE)** — real-time token streaming via Server-Sent Events
- **Pluggable adapters** — register any ACP-compliant agent with a simple adapter class
- **Automatic permissions** — auto-approves agent permission requests (allow-always / allow-once)
- **Built-in agents** — ships with Devin and Kimi adapters out of the box

## Prerequisites

- **Node.js** >= 22
- **npm** >= 10
- An ACP-compatible agent CLI installed and available on `PATH` (e.g. `devin`, `kimi`)

## Quick Start

```bash
npm install
npm run build
npm start
```

The server starts on `http://0.0.0.0:4001` by default. Set `PORT` and `HOST` to override.

## Usage

Send requests just like you would to the OpenAI API:

```bash
# Non-streaming
curl http://localhost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "acp/devin",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "acp/kimi",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Works with any OpenAI-compatible client library:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4001/v1", api_key="unused")
response = client.chat.completions.create(
    model="acp/devin",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completion (streaming and non-streaming) |
| `GET` | `/v1/artifacts/:token` | List files in a conversation workspace |
| `GET` | `/v1/artifacts/:token/*filepath` | Download a workspace file |

See [docs/api.md](docs/api.md) for full request/response schemas.

## Workspaces & Artifacts

Each conversation gets an isolated workspace directory. The gateway manages a complete file lifecycle between the client and the ACP agent. See [docs/architecture.md](docs/architecture.md) for the full internal details.

### How files flow in (uploads)

Files sent by the client (base64 `image_url` data URIs or `file` attachment blocks in messages) are automatically decoded and written to the workspace under `uploads/`. The agent's CWD is set to the workspace directory, and the prompt includes the list of uploaded file paths so the agent can access them directly from disk.

### How files flow out (artifacts)

Any files the agent creates during execution land in the workspace. After the response completes, the gateway returns artifact metadata — a token and a file list — so the client can download them:

- **Non-streaming**: the JSON response includes an `artifacts` field and a `conversation_id` field
- **Streaming**: a final SSE event with `artifacts` is emitted before the `[DONE]` marker

File content is **never inlined** in the chat completion response. The client retrieves files via separate HTTP requests:

```bash
# List files in workspace
curl http://localhost:4001/v1/artifacts/<token>

# Download a specific file
curl http://localhost:4001/v1/artifacts/<token>/path/to/file.py
```

### Conversation continuity

Pass `X-Conversation-Id` header or `conversation_id` body param to reuse a workspace across requests. Files from previous turns remain available to the agent. The response always includes `X-Conversation-Id` (header) and `conversation_id` (body field in non-streaming mode).

Workspaces are automatically garbage-collected after 1 hour of inactivity (configurable via `WORKSPACE_TTL_MS`).

### Prompt translation

The gateway converts the OpenAI `messages` array into a single plaintext transcript for the ACP agent (system messages, user/assistant/tool turns). The gateway does not inject additional instructions — the prompt is a faithful translation of what the client sent. See [docs/architecture.md](docs/architecture.md#prompt-translation) for the full conversion rules.


## Model Routing

The gateway resolves which ACP agent to use based on the `model` field:

| Model name | Agent |
|------------|-------|
| `acp/devin`, `acp-devin`, `cognition`, `devin-cli` | Devin |
| `acp/kimi`, `acp-kimi`, `moonshot`, `kimi-code` | Kimi |

### Dynamic Model Discovery

On startup, the gateway spawns each registered agent and queries its available models via the ACP protocol. Discovered models are exposed with an `{agentId}/{modelId}` prefix:

```bash
# Use a specific underlying model through Devin
curl http://localhost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "devin/claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The `/v1/models` endpoint returns both base adapter models (e.g. `acp/devin`) and any discovered per-agent models (e.g. `devin/claude-opus-4`, `devin/gpt-4o`).

You can also pass `"agent": "devin"` in the request body to explicitly select an adapter regardless of the model name.

Set `ROUTER_DEFAULT_AGENT` to choose the fallback agent for unrecognized model names (default: `kimi`).

## Agent Isolation

The gateway implements a three-tier isolation system to limit what spawned agents can access:

| Mode | Mechanism | When used |
|------|-----------|-----------|
| **Docker** | Full container namespace isolation | `acp-gateway-agent` image is available |
| **Sandbox** | OS-level file/network isolation via `--sandbox` | Default when Docker is unavailable |
| **Direct** | No OS-level isolation | Explicit opt-in via `AGENT_ISOLATION=direct` |

All modes include **workspace-scoped permission filtering** — the gateway automatically denies agent permission requests targeting paths outside the conversation workspace.

```bash
# Override auto-detection
AGENT_ISOLATION=sandbox npm start

# Build and use the Docker isolation image
npm run docker:build
AGENT_ISOLATION=docker npm start
```

See [docs/sandboxing.md](docs/sandboxing.md) for the full reference.

## Configuration

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `4001` |
| `HOST` | HTTP server bind address | `0.0.0.0` |
| `LOG_LEVEL` | Log verbosity: `error`, `warn`, `info`, `debug` | `info` |
| `ROUTER_DEFAULT_AGENT` | Default agent for unknown models | `kimi` |
| `WORKSPACE_BASE_DIR` | Base directory for conversation workspaces | `$XDG_DATA_HOME/acp-gateway/workspaces` |
| `WORKSPACE_TTL_MS` | Workspace expiry time in milliseconds | `3600000` (1 hour) |
| `AGENT_ISOLATION` | Isolation mode: `docker`, `sandbox`, `direct`, `auto` | `auto` |
| `AGENT_DOCKER_IMAGE` | Docker image name for Docker isolation | `acp-gateway-agent` |

### Adapter Settings

Each adapter resolves its settings from a three-tier hierarchy: **request params** > **env vars** > **defaults**.

| Variable | Description | Default |
|----------|-------------|---------|
| `DEVIN_BIN` | Path to Devin CLI binary | `devin` |
| `DEVIN_ARGS` | CLI arguments (space-separated) | `acp` |
| `DEVIN_MODE_ID` | ACP session mode | *(none)* |
| `DEVIN_BOOTSTRAP_COMMANDS` | Startup commands (space-separated) | *(none)* |
| `KIMI_BIN` | Path to Kimi CLI binary | `kimi` |
| `KIMI_ARGS` | CLI arguments (space-separated) | `acp` |
| `KIMI_MODE_ID` | ACP session mode | `code` |
| `KIMI_BOOTSTRAP_COMMANDS` | Startup commands (space-separated) | `/plan off /yolo` |

See [docs/configuration.md](docs/configuration.md) for the full reference including per-request overrides.

## Adding a Custom Adapter

Extend `StaticAdapter` to register a new agent:

```typescript
import { StaticAdapter } from "./adapters/static.js";

class MyAgentAdapter extends StaticAdapter {
  constructor() {
    super({
      agentId: "my-agent",
      defaultBin: "my-agent-cli",
      defaultArgs: ["acp"],
      aliases: ["my-agent", "custom"],
      envVarPrefix: "MY_AGENT",
    });
  }
}
```

Then register it in `serve.ts`:

```typescript
registry.register(new MyAgentAdapter());
```

See [docs/adapters.md](docs/adapters.md) for more details.

## Project Structure

```
src/
  serve.ts          Express app entry point (HTTP server, routes)
  router_handler.ts Core handler — converts OpenAI requests to ACP calls
  runtime.ts        Spawns ACP agent subprocess, manages protocol lifecycle
  client.ts         ACP Client — permission handling, event queue, file tracking
  registry.ts       Model-to-adapter resolution
  workspace.ts      Per-conversation workspace manager (files, GC, artifacts)
  schemas.ts        AgentSpec interface
  utils.ts          Message formatting, content extraction, path helpers
  logger.ts         Lightweight logger with LOG_LEVEL support
  adapters/
    base.ts         Adapter interface and baseMatches() helper
    static.ts       StaticAdapter base class (env var + optional_params config)
    devin.ts        DevinAdapter
    kimi.ts         KimiAdapter
    index.ts        Barrel export
docker/
  agent/
    Dockerfile      Agent isolation container image
    install-devin.sh  Devin CLI installer for Docker builds
docs/
  architecture.md   Internal architecture overview
  api.md            API endpoint reference
  configuration.md  Full configuration reference
  adapters.md       Adapter system documentation
  sandboxing.md     Agent isolation reference
test/
  *.test.ts         Unit tests (node:test)
  mock-agent.ts     Mock ACP agent for testing
  integration/      HTTP endpoint integration tests
```

## Demo UI

You can launch [Open WebUI](https://github.com/open-webui/open-webui) via Docker for a ChatGPT-like demo interface:

```bash
# Start the gateway first
npm run dev

# In another terminal, start Open WebUI (requires Docker)
npm run demo:ui
```

Open http://localhost:3000, then select an `acp/*` model to start chatting.

## Development

```bash
npm run dev              # Build and start
npm run lint             # Lint with oxlint
npm run format           # Format with oxfmt
npm run format:check     # Check formatting without writing
npm run typecheck        # Type-check with tsc
npm run test:node        # Unit tests only
npm run test:integration # Integration tests only
npm run test             # Lint + format check + unit tests
npm run test:all         # All of the above + integration tests
npm run demo:ui          # Open WebUI via Docker (port 3000)
```

## Credits

Inspired by the ideas of [nulrouter/acp-router](https://github.com/nulrouter/acp-router).
