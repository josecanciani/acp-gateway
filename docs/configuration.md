# Configuration

All configuration is done through environment variables and/or per-request `optional_params`.

## Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `4001` |
| `HOST` | HTTP server bind address | `0.0.0.0` |
| `ROUTER_DEFAULT_AGENT` | Default agent for unrecognized model names | `kimi` |

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
2. Pattern match on model name (`acp/{agentId}` or `acp-{agentId}`)
3. Alias match (e.g. `cognition` -> Devin)
4. `ROUTER_DEFAULT_AGENT` environment variable
5. First registered adapter

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
