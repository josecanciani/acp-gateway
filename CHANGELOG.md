# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Docker agent image version tracking via `AGENT_IMAGE_VERSION` constant and `acp-gateway.version` Docker label. The image is automatically rebuilt at startup when the version changes.
- Model discovery now logs per-adapter progress at startup (probing, model count, or failure reason).

### Fixed
- Model discovery no longer marks agents as available when their binary is missing (e.g. kimi in Docker mode). Only agents that report models are shown.
- Docker containers now set `--hostname acp-agent-container` so agents can detect they're running in a container instead of reporting the host machine name.

### Changed
- Docker credential mounts simplified to only mount `credentials.toml` (authentication token). The host `config.json` and `mcp/` directory are no longer mounted — they contain macOS-specific paths that don't apply inside containers.
- Docker naming convention: `demo:ui` container now uses `--name acp-gateway-webui` and volume `acp-gateway-webui-data` (was anonymous container with `open-webui-demo` volume).
- `demo:ui` container output is now redirected to a log file (`$XDG_DATA_HOME/acp-gateway/webui.log`) instead of flooding the terminal. On failure, the last 20 lines are shown automatically.

## [1.3.0] - 2026-04-20
### Added
- Per-conversation workspace support: file uploads from OpenAI-compatible clients are materialized into workspace directories.
- `GET /v1/artifacts/:token` endpoint to list files created by the agent during a conversation.
- `GET /v1/artifacts/:token/*filepath` endpoint to download individual workspace files.
- `X-Conversation-Id` header and `conversation_id` body param for conversation continuity.
- `WorkspaceManager` module (`src/workspace.ts`) for workspace lifecycle management with automatic GC.
- File tracking from ACP `tool_call` and `tool_call_update` events (`TrackedFile` in client).
- `WORKSPACE_BASE_DIR` and `WORKSPACE_TTL_MS` environment variables.
- Three-tier agent isolation system: Docker (full container isolation), Sandbox (`--sandbox` flag for OS-level isolation), and Direct (no isolation).
- Workspace-scoped permission filtering in `AgentClient`: denies agent permission requests for paths outside the conversation workspace.
- `AGENT_ISOLATION` environment variable to override isolation mode auto-detection (`docker`, `sandbox`, `direct`, `auto`).
- `AGENT_DOCKER_IMAGE` environment variable to configure the Docker isolation image name.
- `docker/agent/Dockerfile` and `install-devin.sh` for building the agent isolation container image.
- `npm run docker:build` script to build the agent isolation Docker image manually.
- Docker image is built automatically at startup when Docker mode is selected and the image is missing (falls back to sandbox on failure).
- Unit tests for permission filtering and event queue (`test/client.test.ts`).
- `docs/sandboxing.md` — full reference for the agent isolation system.
- `LOG_LEVEL` environment variable to control log verbosity (`error`, `warn`, `info`, `debug`; default `info`).
- Lightweight logger module (`src/logger.ts`).
- Documentation for prompt translation rules, workspace file lifecycle, and artifact response format in `architecture.md`, `README.md`, and `api.md`.

### Changed
- `messagesToPrompt()` no longer injects hardcoded instructions into the ACP prompt — the prompt is now a faithful translation of the client's messages.
- Workspace default directory follows the XDG Base Directory Specification (`$XDG_DATA_HOME/acp-gateway/workspaces`, defaults to `~/.local/share/acp-gateway/workspaces`).
- JSON body size limit increased from 10 MB to 50 MB to support file uploads.
- Non-streaming responses now include `conversation_id` and `artifacts` fields.
- Streaming responses emit artifact metadata as a final SSE event before `[DONE]`.
- `Runtime.runStreamWithClient()` exposes both stream and client for post-stream file tracking.
- `Runtime` now accepts an `isolationMode` parameter and spawns agents accordingly via `spawnAgent()`.
- `AgentClient` constructor now accepts an optional `workspaceDir` parameter for path-scoped permission filtering.
- Server startup output is now compact (URL, isolation mode, agent summary) instead of verbose banner with full model list.
- Agent subprocess stderr is suppressed during model discovery and prompts (visible at `LOG_LEVEL=debug`).
- Docker auto-detection probes daemon availability (`docker info`) instead of image existence; image is built on demand.

## [1.2.0] - 2026-04-19
### Added
- `npm run demo:ui` script to launch Open WebUI via Docker for demos.

### Changed
- `/v1/models` no longer shows generic `acp/{agentId}` entries when per-model entries are discovered (e.g. `devin/claude-opus-4-6-thinking` instead of `acp/devin`).
- `/v1/models` only lists agents whose CLI binary is actually installed.

### Fixed
- Model discovery now reads from ACP `configOptions` response (was looking for a non-existent `models.availableModels` field).
- `_cognition.ai/agent_stopped` notification no longer logs "Method not found" errors (added `extNotification` handler to `AgentClient`).
- `discoverModels` now properly throws when agent binary is unreachable instead of silently returning empty.

## [1.1.0] - 2026-04-19
### Added
- `keep-a-changelog` dev dependency for changelog validation and formatting.
- `npm run changelog` and `npm run changelog:check` scripts.
- Dynamic model discovery: on startup, the gateway spawns each agent, queries available models via the ACP `newSession` response, and caches them.
- `/v1/models` now returns both base adapter models (e.g. `acp/devin`) and discovered per-agent models (e.g. `devin/claude-opus-4`).
- `{agentId}/{modelId}` routing: requesting a model like `devin/claude-opus-4` resolves to the Devin adapter and calls `unstable_setSessionModel` to select that model.
- `modelId` field on `AgentSpec` for passing model selection through the runtime.
- `DiscoveredModel` interface in `schemas.ts`.
- `Registry.setModels()`, `Registry.getModels()`, `Registry.listAllModels()`, `Registry.listAdapters()` methods.
- `Runtime.discoverModels()` method for querying agent models via ACP.
- Unit tests for model routing and `listAllModels`.
- Integration test for model discovery and `{agentId}/{modelId}` request routing.

## [1.0.1] - 2026-04-19
### Added
- Documentation site under `docs/` with architecture, API reference, configuration, and adapter guides.
- Prerequisites section in README (Node.js >= 22, npm >= 10).
- Python client usage example in README.
- Complete environment variable reference in README (HOST, MODE_ID, BOOTSTRAP_COMMANDS).
- Missing model aliases (`devin-cli`, `kimi-code`) to README routing table.

### Fixed
- `test:node` script was silently running 0 unit tests (used wrong tsconfig and glob path).
- README default port corrected from `4000` to `4001`.
- README described `*_ARGS` env vars as "JSON array" — they are space-separated strings.
- README module descriptions corrected (`schemas.ts` is a TypeScript interface, not Zod; `client.ts` handles permissions/events, not subprocess spawning).
- `.npmignore` now excludes `src/`, `dist-test/`, `tsconfig.test.json`, and `docs/` from published package.

[Unreleased]: https://github.com/josecanciani/acp-gateway/compare/1.3.0...HEAD
[1.3.0]: https://github.com/josecanciani/acp-gateway/compare/1.2.0...1.3.0
[1.2.0]: https://github.com/josecanciani/acp-gateway/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/josecanciani/acp-gateway/compare/1.0.1...1.1.0
[1.0.1]: https://github.com/josecanciani/acp-gateway/releases/tag/1.0.1
