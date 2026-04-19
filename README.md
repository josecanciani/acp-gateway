# acp-gateway

A lightweight TypeScript gateway that exposes OpenAI-compatible `/v1/chat/completions` endpoints and routes requests to [Agent Client Protocol](https://agentclientprotocol.org/) (ACP) agents like Devin and Kimi. Supports streaming (SSE) and non-streaming responses, pluggable adapters, and automatic permission handling.

## Features

- **OpenAI-compatible API** — drop-in replacement for `/v1/chat/completions` and `/v1/models`
- **Streaming (SSE)** — real-time token streaming via Server-Sent Events
- **Pluggable adapters** — register any ACP-compliant agent with a simple adapter class
- **Automatic permissions** — auto-approves agent permission requests (allow-always / allow-once)
- **Built-in agents** — ships with Devin and Kimi adapters out of the box

## Quick Start

```bash
npm install
npm run build
npm start
```

The server starts on port `4000` by default (set `PORT` to override).

## Usage

Send requests just like you would to the OpenAI API:

```bash
# Non-streaming
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "acp/devin",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "acp/kimi",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completion (streaming and non-streaming) |

## Model Routing

The gateway resolves which ACP agent to use based on the `model` field:

| Model name | Agent |
|------------|-------|
| `acp/devin`, `acp-devin`, `cognition` | Devin |
| `acp/kimi`, `acp-kimi`, `moonshot` | Kimi |

Set `ROUTER_DEFAULT_AGENT` to choose the fallback agent for unrecognized model names (default: `kimi`).

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

## Configuration

Adapters can be configured via environment variables:

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: `4000`) |
| `ROUTER_DEFAULT_AGENT` | Default agent for unknown models (default: `kimi`) |
| `DEVIN_BIN` | Path to Devin CLI binary |
| `DEVIN_ARGS` | Custom arguments (JSON array) |
| `KIMI_BIN` | Path to Kimi CLI binary |
| `KIMI_ARGS` | Custom arguments (JSON array) |

## Project Structure

```
src/
  adapters/       Pluggable agent adapters (base, static, devin, kimi)
  client.ts       ACP client — spawns agent subprocess, manages connection
  registry.ts     Model-to-adapter resolution
  router_handler.ts  Express handler — completion & streaming logic
  runtime.ts      ACP session lifecycle (init, prompt, collect results)
  schemas.ts      Zod schemas for request validation
  serve.ts        Express app entry point
  utils.ts        Message formatting, permission handling
test/
  *.test.ts       Unit tests (node:test)
  mock-agent.ts   Mock ACP agent for testing
  integration/    HTTP endpoint integration tests
```

## Development

```bash
npm run dev          # Build and start
npm run lint         # Lint with oxlint
npm run format       # Format with oxfmt
npm run typecheck    # Type-check with tsc
npm run test:node    # Unit tests
npm run test:integration  # Integration tests
npm run test:all     # Lint + unit + integration
```

## Credits

Node.js/TypeScript port of [nulrouter/acp-router](https://github.com/nulrouter/acp-router) (Python).
