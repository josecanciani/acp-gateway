# Configuration

All configuration is done through environment variables and/or per-request `optional_params`.

## Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `4001` |
| `HOST` | HTTP server bind address | `0.0.0.0` |
| `LOG_LEVEL` | Log verbosity: `error`, `warn`, `info`, `debug` | `info` |
| `ROUTER_DEFAULT_AGENT` | Default agent for unrecognized model names | `kimi` |
| `GATEWAY_SYSTEM_PROMPT` | System prompt prepended to every request. Set to empty string to disable | *(see below)* |

### Gateway System Prompt

By default the gateway prepends a system message that instructs the agent to behave as a standard LLM (answer from knowledge, no tool use). This makes the endpoint feel like a regular chat model when accessed by OpenAI-compatible clients.

Set `GATEWAY_SYSTEM_PROMPT` to override the text, or set it to an empty string (`""`) to disable injection entirely — useful when callers already supply their own system prompt.

## Tool Bridge

The gateway can transparently bridge OpenAI-style `tools` in a request to MCP tools that ACP agents can use. When a request includes a `tools` array, the gateway spawns a temporary MCP server exposing those tools, passes it to the agent, and converts agent tool calls back to OpenAI `tool_calls` in the response. See [tool-bridge.md](tool-bridge.md) for the full architecture.

| Variable | Description | Default |
|----------|-------------|---------|
| `TOOL_BRIDGE_ENABLED` | Enable/disable the tool bridge (`true`/`false`) | `true` |
| `TOOL_BRIDGE_COLLECTION_WINDOW_MS` | Time (ms) to wait for additional tool calls after the first one | `500` |
| `TOOL_BRIDGE_SYSTEM_PROMPT` | System prompt used when tools are present (replaces the default gateway prompt) | *(built-in MCP-focused prompt)* |

When tools are present in a request and the bridge is enabled:
- The default `GATEWAY_SYSTEM_PROMPT` is replaced by `TOOL_BRIDGE_SYSTEM_PROMPT`
- Tool definitions are stripped from the prompt text (they become MCP tools instead)
- The response may contain `tool_calls` with `finish_reason: "tool_calls"` instead of `stop`

## Adapter Settings

Each adapter reads its settings from a three-tier hierarchy (highest priority first):

1. **Request `optional_params`** -- per-request overrides sent in the JSON body
2. **Environment variables** -- server-level defaults
3. **Adapter defaults** -- hardcoded fallback values

### Devin

| Setting | optional_params key | Env variable | Default |
|---------|---------------------|--------------|---------|
| Binary | `devin_bin` / `agent_bin` | `DEVIN_BIN` | `devin` |
| Arguments | `devin_args` / `agent_args` | `DEVIN_ARGS` | `acp` |
| Session mode | `devin_mode_id` / `agent_mode_id` | `DEVIN_MODE_ID` | *(none)* |
| Bootstrap commands | `devin_bootstrap_commands` / `bootstrap_commands` | `DEVIN_BOOTSTRAP_COMMANDS` | *(none)* |

### Kimi

| Setting | optional_params key | Env variable | Default |
|---------|---------------------|--------------|---------|
| Binary | `kimi_bin` / `agent_bin` | `KIMI_BIN` | `kimi` |
| Arguments | `kimi_args` / `agent_args` | `KIMI_ARGS` | `acp` |
| Session mode | `kimi_mode_id` / `agent_mode_id` | `KIMI_MODE_ID` | `code` |
| Bootstrap commands | `kimi_bootstrap_commands` / `bootstrap_commands` | `KIMI_BOOTSTRAP_COMMANDS` | `/plan off /yolo` |

### Environment Variable Formats

- **`*_ARGS`** and **`*_BOOTSTRAP_COMMANDS`** are **space-separated** strings (e.g. `DEVIN_ARGS="acp --verbose"`).
- **`*_BIN`** is a single path or command name.
- **`*_MODE_ID`** is a single string identifier.

## Model Routing

The `model` field in the request determines which agent handles it:

| Model name | Agent |
|------------|-------|
| `acp/devin`, `acp-devin`, `cognition`, `devin-cli` | Devin |
| `acp/kimi`, `acp-kimi`, `moonshot`, `kimi-code` | Kimi |

Resolution order:

1. Explicit `agent` key in `optional_params` (e.g. `{ "agent": "devin" }`)
2. `{agentId}/{modelId}` pattern (e.g. `devin/claude-opus-4`) — routes to the agent and selects the underlying model
3. Pattern match on model name (`acp/{agentId}` or `acp-{agentId}`)
4. Alias match (e.g. `cognition` -> Devin)
5. `ROUTER_DEFAULT_AGENT` environment variable
6. First registered adapter

### Dynamic Model Discovery

On startup, the gateway spawns each registered agent, performs the ACP handshake, and reads the `models` field from the `newSession` response. Discovered models are cached and exposed via `/v1/models` with an `{agentId}/{modelId}` prefix (e.g. `devin/claude-opus-4`).

When a request uses an `{agentId}/{modelId}` model name, the gateway:
1. Resolves the adapter from the agent ID
2. After creating the ACP session, calls `unstable_setSessionModel` to switch to the requested model
3. Proceeds with the prompt as usual

If the model ID is not recognized (not in the cached list), the request still routes to the adapter but without model selection.

## Per-Request Overrides

Any unknown keys in the request body (beyond `model`, `messages`, `stream`, `tools`) are passed through as `optional_params`. This allows per-request configuration:

```json
{
  "model": "acp/devin",
  "messages": [{"role": "user", "content": "Hello"}],
  "agent_bin": "/custom/path/devin",
  "cwd": "/my/project"
}
```

### Working Directory Keys

The following keys (checked in `optional_params` then `optional_params.metadata`) set the agent's working directory:

`cwd`, `workspace_path`, `project_root`, `root_dir`, `path`
