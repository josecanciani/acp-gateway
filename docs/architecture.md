# Architecture

This document describes the internal architecture of acp-gateway.

## Overview

acp-gateway is a TypeScript HTTP server that translates [OpenAI-compatible](https://platform.openai.com/docs/api-reference/chat) chat completion requests into [Agent Client Protocol](https://agentclientprotocol.org/) (ACP) calls. It spawns ACP agent subprocesses, communicates over stdio using newline-delimited JSON, and streams results back as SSE or a single JSON response.

## Request Flow

```
HTTP POST /v1/chat/completions
  -> Express handler (serve.ts)
  -> WorkspaceManager.getOrCreate(conversationId) -> workspace dir (workspace.ts)
  -> WorkspaceManager.materializeFiles(messages) -> write uploads to workspace
  -> RouterHandler.streamingWithContext(body, workspace) (router_handler.ts)
  -> Registry.resolve(model, optionalParams) -> { adapter, modelId? } (registry.ts)
  -> Adapter.buildSpec(optionalParams) -> AgentSpec (adapters/static.ts)
  -> Runtime.runStreamWithClient(spec, prompt, optionalParams, messages, cwd) (runtime.ts)
     -> spawnAgent(spec, cwd) -> isolation-mode-aware process spawn
     -> ACP connection over stdio
     -> initialize -> newSession(sessionCwd) -> [unstable_setSessionModel] -> setSessionMode -> prompt
     -> yield StreamChunk events from AgentClient(workspaceDir) queue
  -> Express formats as SSE (streaming) or JSON (non-streaming)
  -> Emit artifact info (token, files) in response
```

## Module Responsibilities

### serve.ts (entry point)

Creates the Express application, registers adapters, and starts the HTTP server. This is the only module with side effects; all other modules are pure and testable.

- Detects the isolation mode at startup via `detectIsolationMode()`
- Registers `KimiAdapter` and `DevinAdapter` into a `Registry`
- Triggers background model discovery for all adapters on startup
- Exposes endpoints: `GET /v1/models`, `POST /v1/chat/completions`, `GET /health`, `GET /v1/artifacts/:token`, `GET /v1/artifacts/:token/*filepath`
- `/v1/models` returns both base adapter models and dynamically discovered per-agent models
- Manages conversation IDs via `X-Conversation-Id` header or `conversation_id` body param
- Formats streaming responses as SSE with OpenAI-compatible JSON payloads (plus artifact metadata)
- Formats non-streaming responses as a single `ChatCompletionResponse` (plus `conversation_id` and `artifacts`)
- Runs periodic workspace garbage collection (every 10 minutes)

### router_handler.ts (request handler)

Converts incoming HTTP request bodies into ACP agent invocations.

- `streaming(body)` -- async generator that yields `StreamChunk` objects
- `streamingWithContext(body, workspace)` -- integrates workspace, returns stream + artifact context
- `completion(body)` -- collects all chunks and returns a `ChatCompletionResponse` with `conversation_id` and `artifacts`
- Resolves the adapter and optional model ID via `Registry`, builds an `AgentSpec` (with `modelId` if specified), converts messages to a prompt string, and delegates to `Runtime`

### runtime.ts (agent lifecycle)

Spawns the agent subprocess, establishes the ACP connection, runs the protocol handshake, and streams results. **A fresh process is spawned for every request and killed when the response completes** — there is no connection pooling or process reuse.

The runtime supports three isolation modes (see [sandboxing.md](sandboxing.md)):

| Mode | Spawn Strategy |
|------|---------------|
| `docker` | `docker run --rm -i -v cwd:/workspace ... image bin --sandbox args` |
| `sandbox` | `bin --sandbox args` |
| `direct` | `bin args` |

1. **Spawn** -- `spawnAgent(spec, cwd)` selects the spawn strategy based on isolation mode
2. **Connect** -- converts Node streams to Web streams, creates `ndJsonStream` and `ClientSideConnection`
3. **Handshake** -- `initialize()` -> `newSession(sessionCwd)` -> `unstable_setSessionModel()` (if `modelId` set) -> `setSessionMode()` (optional)
4. **Bootstrap** -- runs bootstrap commands (e.g. `/plan off`) with stream suppression
5. **Prompt** -- sends the user prompt and polls the client event queue for text chunks
6. **Cleanup** -- kills the agent process in a `finally` block

In Docker mode, the host CWD is mounted at `/workspace` and the session CWD is translated accordingly.

The runtime also exposes:
- `runStreamWithClient(spec, prompt, optionalParams, messages, cwd?)` -- returns both the stream and the `AgentClient` instance (for post-stream file tracking)
- `discoverModels(spec)` -- spawns an agent, performs the ACP handshake, reads available models from the `configOptions` field in the `newSession` response, and returns a list of `DiscoveredModel` objects

### client.ts (ACP client)

Implements the ACP SDK `Client` interface. Handles four responsibilities:

- **Event queue** -- `sessionUpdate` events push text chunks into a queue; consumers pull them with `pullEvent(timeoutMs)`. This decouples the ACP connection from the HTTP response stream.
- **Permission handling** -- `requestPermission` auto-allows by default, preferring `allow_always` over `allow_once`. If no allow option is available, the request is cancelled.
- **Workspace-scoped permission filtering** -- when `workspaceDir` is set, permission requests for paths outside the workspace are automatically denied. Path extraction checks `toolCall.locations[].path` and `toolCall.rawInput` keys (`path`, `file_path`, `directory`, `dir`, `cwd`). Non-path permissions (e.g. web search) are always allowed. See [sandboxing.md](sandboxing.md) for details.
- **File tracking** -- `tool_call` and `tool_call_update` events with `locations` are tracked in `trackedFiles: TrackedFile[]`. After the stream completes, consumers can inspect which files the agent created or modified.

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

### workspace.ts (workspace manager)

Manages per-conversation workspace directories for file materialization and artifact serving.

- `getOrCreate(conversationId?)` -- creates or retrieves a workspace directory with a unique token
- `materializeFiles(workspace, messages)` -- extracts base64 `image_url` data URIs and file attachments from OpenAI messages, writes them to the workspace directory
- `listFiles(workspace)` -- recursively lists all files in a workspace
- `resolveFilePath(workspace, relativePath)` -- safely resolves a relative path with directory traversal prevention
- `getByToken(token)` -- looks up a workspace by its security token (for artifact endpoints)
- `gc()` -- removes workspaces that have exceeded the configured TTL

Each workspace has: `conversationId`, `token` (random hex for secure URL access), `dir` (filesystem path), `createdAt`, `lastAccessedAt`.

## Prompt Translation

ACP agents accept a single text prompt, not an OpenAI `messages` array. The gateway converts the structured chat history into a plaintext transcript via `messagesToPrompt()` in `utils.ts`. The gateway does not inject any additional instructions — the prompt is a faithful translation of what the client sent.

**How messages are converted:**

| OpenAI role | Prompt format |
|-------------|---------------|
| `system` | Grouped under a `System instructions:` header at the top |
| `user` | `User: <content>` |
| `assistant` | `Assistant: <content>` |
| `tool` | `Tool (<name>): <content>` |

Rich content blocks (arrays of `{ type: "text", text }`, nested `content` fields, `input_text`, `output_text`) are recursively flattened to plain text via `contentBlocksToText()`. Non-text content blocks (e.g. `image_url`) are stripped from the prompt text — binary data is handled separately through workspace file materialization (see below).

If the request includes a `tools` array, the function names are appended as hints so the agent is aware of the client's tool definitions.

**Example transformation:**

```
// OpenAI messages input:
[
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "user", "content": "Create a hello.py file" },
  { "role": "assistant", "content": "Done!" },
  { "role": "user", "content": "Now add error handling" }
]

// ACP prompt output:
System instructions:
You are a helpful assistant.

Conversation:
User: Create a hello.py file