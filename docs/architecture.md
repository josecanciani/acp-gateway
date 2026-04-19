# Architecture

This document describes the internal architecture of acp-gateway.

## Overview

acp-gateway is a TypeScript HTTP server that translates [OpenAI-compatible](https://platform.openai.com/docs/api-reference/chat) chat completion requests into [Agent Client Protocol](https://agentclientprotocol.org/) (ACP) calls. It spawns ACP agent subprocesses, communicates over stdio using newline-delimited JSON, and streams results back as SSE or a single JSON response.

## Request Flow

```
HTTP POST /v1/chat/completions
  -> Express handler (serve.ts)
  -> RouterHandler.streaming() or .completion() (router_handler.ts)
  -> Registry.resolve(model, optionalParams) -> { adapter, modelId? } (registry.ts)
  -> Adapter.buildSpec(optionalParams) -> AgentSpec (adapters/static.ts)
  -> Runtime.runStream(spec, prompt, optionalParams, messages) (runtime.ts)
     -> spawn(bin, args) -> ACP connection over stdio
     -> initialize -> newSession -> [unstable_setSessionModel] -> setSessionMode -> prompt
     -> yield StreamChunk events from AgentClient queue
  -> Express formats as SSE (streaming) or JSON (non-streaming)
```

## Module Responsibilities

### serve.ts (entry point)

Creates the Express application, registers adapters, and starts the HTTP server. This is the only module with side effects; all other modules are pure and testable.

- Registers `KimiAdapter` and `DevinAdapter` into a `Registry`
- Triggers background model discovery for all adapters on startup
- Exposes three endpoints: `GET /v1/models`, `POST /v1/chat/completions`, `GET /health`
- `/v1/models` returns both base adapter models and dynamically discovered per-agent models
- Formats streaming responses as SSE with OpenAI-compatible JSON payloads
- Formats non-streaming responses as a single `ChatCompletionResponse`

### router_handler.ts (request handler)

Converts incoming HTTP request bodies into ACP agent invocations.

- `streaming(body)` -- async generator that yields `StreamChunk` objects
- `completion(body)` -- collects all chunks and returns a `ChatCompletionResponse`
- Resolves the adapter and optional model ID via `Registry`, builds an `AgentSpec` (with `modelId` if specified), converts messages to a prompt string, and delegates to `Runtime`

### runtime.ts (agent lifecycle)

Spawns the agent subprocess, establishes the ACP connection, runs the protocol handshake, and streams results.

1. **Spawn** -- `child_process.spawn(bin, args)` with stdio pipes
2. **Connect** -- converts Node streams to Web streams, creates `ndJsonStream` and `ClientSideConnection`
3. **Handshake** -- `initialize()` -> `newSession(cwd, mcpServers)` -> `unstable_setSessionModel()` (if `modelId` set) -> `setSessionMode()` (optional)
4. **Bootstrap** -- runs bootstrap commands (e.g. `/plan off`) with stream suppression
5. **Prompt** -- sends the user prompt and polls the client event queue for text chunks
6. **Cleanup** -- kills the agent process in a `finally` block

The runtime also exposes `discoverModels(spec)` which spawns an agent, performs the ACP handshake, reads the `models.availableModels` field from the `newSession` response, and returns a list of `DiscoveredModel` objects.

### client.ts (ACP client)

Implements the ACP SDK `Client` interface. Handles two responsibilities:

- **Event queue** -- `sessionUpdate` events push text chunks into a queue; consumers pull them with `pullEvent(timeoutMs)`. This decouples the ACP connection from the HTTP response stream.
- **Permission handling** -- `requestPermission` auto-allows by default, preferring `allow_always` over `allow_once`. If no allow option is available, the request is cancelled.

### registry.ts (model routing)

Maps the `model` field from the request to an adapter instance (and optional model ID) using a multi-strategy lookup. Returns a `ResolvedRoute { adapter, modelId? }`.

1. Explicit `agent` param in `optional_params`
2. `{agentId}/{modelId}` pattern (e.g. `devin/claude-opus-4`)
3. Pattern match: `acp/{agentId}` or `acp-{agentId}`
4. Adapter aliases (e.g. `cognition` -> Devin, `moonshot` -> Kimi)
5. Default agent (configurable via `ROUTER_DEFAULT_AGENT`)
6. First registered adapter (last resort)

Also manages discovered models via `setModels()`, `getModels()`, `listAllModels()`, and `listAdapters()`.

### adapters/ (pluggable agents)

Each adapter extends `StaticAdapter` and defines an agent's binary, arguments, mode, bootstrap commands, aliases, and environment variable prefix.

`StaticAdapter.buildSpec()` resolves each setting from a three-tier hierarchy:

```
Request optional_params  ->  Environment variables  ->  Adapter defaults
```

See [configuration.md](configuration.md) for the full list of settings.

### utils.ts (utilities)

Shared helpers for message formatting, content extraction, path resolution, and permission selection. Key functions:

| Function | Purpose |
|----------|---------|
| `messagesToPrompt()` | Converts OpenAI messages array to a formatted prompt string |
| `contentBlocksToText()` | Recursively extracts text from ACP content block structures |
| `normalizeIncomingMessages()` | Normalizes various request body formats into a `Message[]` |
| `pickPermissionOption()` | Selects the best allow option from a permission request |
| `extractExistingPathsFromText()` | Finds filesystem paths in text (for working directory resolution) |
| `commonExistingParent()` | Finds the common parent directory of a set of paths |

### schemas.ts (types)

Defines the `AgentSpec` and `DiscoveredModel` interfaces:

```typescript
interface AgentSpec {
  agentId: string;
  bin: string;
  args: string[];
  modeId?: string;
  modelId?: string;
  bootstrapCommands: string[];
}

interface DiscoveredModel {
  agentId: string;
  modelId: string;
}
```

## Working Directory Resolution

The runtime resolves the agent's working directory from (in priority order):

1. Request `optional_params` keys: `cwd`, `workspace_path`, `project_root`, `root_dir`, `path`
2. `optional_params.metadata` (same keys)
3. Paths extracted from message text (common parent of existing paths)
4. `process.cwd()` (fallback)

## Permission Handling

When an agent requests permission (e.g. to edit a file), the client automatically selects an allow option:

1. Prefer `allow_always`
2. Fall back to `allow_once`
3. If no allow option exists, cancel the request

This behavior can be overridden by setting the permission mode on the `AgentClient` instance.
