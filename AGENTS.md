# ACP Gateway - Development Guide

## Tech Stack

- **Runtime:** Node.js (ES modules)
- **Language:** TypeScript (strict mode, ES2022 target)
- **Framework:** Express 5
- **ACP SDK:** @agentclientprotocol/sdk
- **Linter:** oxlint
- **Formatter:** oxfmt
- **Testing:** Node.js built-in test runner

## Project Structure

```
acp-gateway/
  src/
    serve.ts              # Express app entry point (HTTP server, routes)
    router_handler.ts     # Core handler — converts OpenAI requests to ACP calls
    runtime.ts            # Spawns ACP agent subprocess, manages protocol lifecycle
    client.ts             # ACP Client implementation (permissions, event queue, file tracking)
    registry.ts           # Model-to-adapter resolution
    workspace.ts          # Per-conversation workspace manager (files, GC, artifacts)
    schemas.ts            # AgentSpec interface
    utils.ts              # Message formatting, content extraction, permission helpers
    adapters/
      base.ts             # Adapter interface and baseMatches() helper
      static.ts           # StaticAdapter base class (env var + optional_params config)
      devin.ts            # DevinAdapter (bin: devin, args: ["acp"])
      kimi.ts             # KimiAdapter (bin: kimi, args: ["acp"], mode: "code")
      index.ts            # Barrel export
  docs/
    architecture.md       # Internal architecture overview
    api.md                # API endpoint reference
    configuration.md      # Full configuration reference
    adapters.md           # Adapter system documentation
  test/
    registry.test.ts      # Unit tests for adapter resolution
    utils.test.ts         # Unit tests for message formatting and utilities
    workspace.test.ts     # Unit tests for workspace manager
    mock-agent.ts         # Mock ACP agent for testing (echoes, errors, permissions, files)
    integration/
      router.integration-test.ts  # HTTP endpoint integration tests
  tsconfig.json           # Build config (src → dist)
  tsconfig.test.json      # Test build config (src + test → dist-test)
```

## Architecture

- **`src/serve.ts`** is the entry point; creates the Express server, registers routes, and starts listening. Not imported by tests.
- **`src/router_handler.ts`** converts OpenAI-compatible chat completion requests into ACP agent calls. Exposes `streaming()` (async generator), `streamingWithContext()` (workspace-aware), and `completion()` (returns full response). Tests import this.
- **`src/runtime.ts`** spawns an ACP agent subprocess via `child_process.spawn`, establishes the ACP connection over stdio using the SDK's `ndJsonStream` and `ClientSideConnection`, manages the protocol lifecycle (initialize → newSession → unstable_setSessionModel → setSessionMode → prompt), and yields streaming chunks. Also exposes `runStreamWithClient()` (returns both stream and client) and `discoverModels()`.
- **`src/client.ts`** implements the ACP `Client` interface. Handles `sessionUpdate` events (text chunks, finished signals), `requestPermission` (auto-allows by default), tracks file locations from `tool_call`/`tool_call_update` events, and provides an async event queue for consumers.
- **`src/workspace.ts`** manages per-conversation workspace directories. Creates isolated temp dirs, materializes uploaded files (base64 images, attachments), provides token-based artifact access, and runs periodic garbage collection.
- **`src/registry.ts`** resolves model names to adapters using multiple strategies: explicit `agent` param → `{agentId}/{modelId}` pattern → model name pattern (`acp/devin`, `acp-devin`) → aliases (`cognition`, `moonshot`) → default agent → first registered. Returns a `ResolvedRoute { adapter, modelId? }`. Also manages discovered models.
- **`src/schemas.ts`** defines `AgentSpec` (with optional `modelId`) and `DiscoveredModel` interfaces.
- **`src/adapters/static.ts`** is the base class for all concrete adapters. Builds an `AgentSpec` from a three-tier config: request optional_params → env vars → adapter defaults.

### Request Flow

```
HTTP POST /v1/chat/completions
  → Express handler (serve.ts)
  → WorkspaceManager.getOrCreate(conversationId) → workspace (workspace.ts)
  → materializeFiles(messages) → write uploads to workspace dir
  → RouterHandler.streamingWithContext() or .completion() (router_handler.ts)
  → Registry.resolve(model, optionalParams) → { adapter, modelId? } (registry.ts)
  → Adapter.buildSpec(optionalParams) → AgentSpec (adapters/static.ts)
  → Runtime.runStreamWithClient(spec, prompt, optionalParams, messages, cwd) (runtime.ts)
    → spawn(bin, args) → ACP connection over stdio
    → initialize → newSession(workspace.dir) → [unstable_setSessionModel] → setSessionMode → prompt
    → yield StreamChunk events from AgentClient queue
  → Express formats as SSE (streaming) or JSON (non-streaming)
  → Emit artifact info (token, files) in response
```

### Permission Handling

When an agent requests permission, the client auto-allows by default (prefers `allow_always` over `allow_once`). If no allow option is available, the request is cancelled.

### Working Directory Resolution

The runtime resolves the agent's CWD from (in priority order):
1. Explicit `cwd` parameter (used by workspace integration — overrides all below)
2. Request `optional_params` (`cwd`, `workspace_path`, `project_root`, `root_dir`, `path`)
3. `optional_params.metadata` (same keys)
4. Paths extracted from message text (common parent of existing paths)
5. Current process directory (fallback)

## Scripts

| Command                  | Description                              |
|--------------------------|------------------------------------------|
| `npm test`               | Run lint, format check, and unit tests   |
| `npm run test:node`      | Run unit tests directly                  |
| `npm run test:integration` | Run integration tests (mock agent)     |
| `npm run test:all`       | Run all tests (lint + unit + integration)|
| `npm run lint`           | Lint with oxlint                         |
| `npm run format`         | Format with oxfmt                        |
| `npm run format:check`   | Check formatting without writing         |
| `npm run typecheck`      | Type-check with tsc                      |
| `npm run changelog`      | Parse and reformat CHANGELOG.md          |
| `npm run changelog:check`| Validate CHANGELOG.md silently           |
| `npm run demo:ui`        | Open WebUI via Docker (port 3000)        |

## Verification

Before considering a change complete, run:

```bash
npm test
```

This runs linting, format checking, and unit tests in sequence.

## Testing

### Unit Tests
```bash
npm run test:node
```
- Uses Node.js built-in test runner
- Test files must end in `.test.ts`
- Located in `test/` directory

### Integration Tests
```bash
npm run test:integration
```
- Starts the Express server with a mock ACP agent adapter
- Hits HTTP endpoints with real HTTP requests
- Mock agent behavior is controlled by prompt text (`echo:`, `error`, `slow`, `multi`, `permission`, `file:`)
- Test files use the `*.integration-test.ts` suffix (excluded from fast `test:node`)

## Configuration

### Environment Variables

| Variable                    | Description                        | Default     |
|-----------------------------|------------------------------------|-------------|
| `PORT`                      | HTTP server port                   | `4001`      |
| `HOST`                      | HTTP server bind address           | `0.0.0.0`   |
| `ROUTER_DEFAULT_AGENT`      | Default agent for unknown models   | `kimi`      |
| `WORKSPACE_BASE_DIR`        | Base directory for workspaces      | `$XDG_DATA_HOME/acp-gateway/workspaces` |
| `WORKSPACE_TTL_MS`          | Workspace expiry (milliseconds)    | `3600000`   |
| `DEVIN_BIN`                 | Path to Devin CLI binary           | `devin`     |
| `DEVIN_ARGS`                | Custom arguments (space-separated) | `acp`       |
| `DEVIN_MODE_ID`             | ACP session mode                   | *(none)*    |
| `DEVIN_BOOTSTRAP_COMMANDS`  | Bootstrap commands (space-separated) | *(none)* |
| `KIMI_BIN`                  | Path to Kimi CLI binary            | `kimi`      |
| `KIMI_ARGS`                 | Custom arguments (space-separated) | `acp`       |
| `KIMI_MODE_ID`              | ACP session mode                   | `code`      |
| `KIMI_BOOTSTRAP_COMMANDS`   | Bootstrap commands (space-separated) | `/plan off /yolo` |

### Model Routing

| Model name                          | Agent |
|-------------------------------------|-------|
| `acp/devin`, `acp-devin`, `cognition`, `devin-cli` | Devin |
| `acp/kimi`, `acp-kimi`, `moonshot`, `kimi-code`    | Kimi  |
| `{agentId}/{modelId}` (e.g. `devin/claude-opus-4`) | Routes to the agent and selects the underlying model |

On startup, the gateway discovers each agent's available models via the ACP `newSession` response and exposes them via `/v1/models`.

### Adapter Config Hierarchy

For each setting (bin, args, mode, bootstrap), the adapter checks in order:
1. Request `optional_params` (e.g. `devin_bin`, `agent_bin`)
2. Environment variables (e.g. `DEVIN_BIN`)
3. Adapter defaults (hardcoded in constructor)

## Constraints

- **TypeScript strict mode.** All source and test files are TypeScript with strict checks enabled.
- **ES modules only.** All files use `import`/`export`. No CommonJS.
- **No hardcoded duplicates.** If a value is stored in a variable, reference it — don't repeat the literal.

## Code Style

- Enforced via oxlint and oxfmt configuration
- Follow existing patterns when adding new adapters or utilities

## Adding a Custom Adapter

Extend `StaticAdapter`:

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

## Skills (`.agents/skills/`)

Read the relevant skill file before working in a specific area:

| Skill | When to read |
|-------|-------------|
| `release-management` | Adding a release entry, bumping version numbers, understanding the release workflow |

## Git

- Do NOT add "Generated by" or "Co-Authored-By" lines to commit messages.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages (e.g. `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).

After completing any task, evaluate whether these files need updates:
- This `AGENTS.md` — if architecture, constraints, or conventions changed
- `README.md` — if setup steps, usage, or user-facing behavior changed
- `CHANGELOG.md` + `package.json` version — after completing a feature or fix, read the `release-management` skill and follow its workflow to add a release entry and bump the version

## CI/CD

GitLab CI (`.gitlab-ci.yml`) runs automatically on every push:
- **check** stage: linting (`oxlint`), formatting (`oxfmt --check`)
- **test** stage: unit tests (`node --test`)
- **release** stage: creates a release when a semver tag is pushed

## Conventions

- Source files live under `src/`.
- Adapters live under `src/adapters/`, one file per agent. Each extends `StaticAdapter`.
- Tests live under `test/` using the `*.test.ts` suffix.
- Integration tests live under `test/integration/` using the `*.integration-test.ts` suffix.
- The entry point (`src/serve.ts`) has side effects. All other modules are pure and testable.
