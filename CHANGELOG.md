# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/josecanciani/acp-gateway/compare/1.1.0...HEAD
[1.1.0]: https://github.com/josecanciani/acp-gateway/compare/1.0.1...1.1.0
[1.0.1]: https://github.com/josecanciani/acp-gateway/releases/tag/1.0.1
