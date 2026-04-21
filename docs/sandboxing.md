# Agent Isolation & Sandboxing

This document describes the isolation system that acp-gateway uses to constrain ACP agent subprocesses.

## Overview

When the gateway spawns an agent, it applies multiple isolation layers to limit filesystem access, network reach, and other OS-level capabilities:

1. **HOME isolation** — each conversation gets its own directory used as the agent's `HOME`, preventing access to the host's MCP servers, config, and credentials.
2. **`--sandbox` flag** — passed to agent CLIs that support it (Devin, Kimi) for OS-level restrictions (bubblewrap on Linux, seatbelt on macOS).
3. **Workspace permission filtering** — the `AgentClient` enforces path-based permission filtering as a baseline defense layer.

These layers are always active — there is no configuration toggle.

## Conversation Directory Structure

Each conversation gets a dedicated directory that serves as the agent's HOME:

```
<workspaces-base>/<conversation-id>/
  .config/devin/config.json          ← bridge MCP config (if tools present)
  .local/share/devin/credentials.toml ← copied from host for auth
  workspace/                          ← agent CWD (project files, artifacts)
```

The `WorkspaceManager` creates this structure. The `Runtime.prepareAgentHome()` method copies credentials and bridge config into it before each agent spawn. The entire directory is cleaned up when the conversation expires.

## How Agents Are Spawned

Every agent runs as a local child process:

```
HOME=/path/to/<conversation-id> spawn(bin, ["--sandbox", ...args])
```

The `--sandbox` flag is only added for adapters that declare `sandbox: true` in their spec (Devin, Kimi). Generic binaries (e.g. `node` for mock agents) don't receive it.

### What `--sandbox` Does

The flag activates the agent CLI's built-in OS-level sandbox:

- **macOS:** seatbelt sandbox (`sandbox-exec`) for filesystem and network restrictions.
- **Linux:** bubblewrap (`bwrap`) with seccomp filters.

The exact restrictions depend on the agent implementation.

## Workspace-Scoped Permission Filtering

The `AgentClient` implements path-based permission filtering as a baseline defense layer.

### How It Works

1. The `AgentClient` receives the workspace directory (derived from the per-conversation workspace).
2. When the agent sends a `requestPermission` event, the client extracts paths from the request.
3. If any extracted path resolves to a location **outside** the workspace, the permission is **automatically denied**.
4. Non-path permissions (e.g. web search, network access) are always allowed.

### Path Extraction

The client checks the following locations in the permission request payload:

- `toolCall.locations[].path`
- `toolCall.rawInput.path`
- `toolCall.rawInput.file_path`
- `toolCall.rawInput.directory`
- `toolCall.rawInput.dir`
- `toolCall.rawInput.cwd`

### Path Traversal Protection

Paths containing `..` segments are normalized (resolved to absolute paths) before checking against the workspace boundary. A request for `/workspace/../etc/passwd` is correctly identified as outside the workspace and denied.

### Behavior Summary

| Scenario | Permission granted? |
|----------|-------------------|
| Path inside workspace | Yes (normal permission logic applies) |
| Path outside workspace | Denied automatically |
| No path in request (e.g. web search) | Yes (normal permission logic applies) |
| No workspace set (model discovery) | Yes (filtering disabled) |

## Full Request Flow with Isolation

```
HTTP POST /v1/chat/completions
  → serve.ts
  → WorkspaceManager.getOrCreate(conversationId) → workspace info (homeDir, dir)
  → RouterHandler.streamingWithContext(body, workspace)
  → Registry.resolve(model) → Adapter → AgentSpec (with sandbox flag)
  → Runtime.runStreamWithClient(spec, prompt, ..., cwd, homeDir)
     → prepareAgentHome(homeDir, bridgeConfigPath) → copy credentials + bridge config
     → Runtime.spawnAgent(spec, homeDir)
        HOME=<homeDir> spawn(bin, ["--sandbox", ...args])
     → ACP connection over stdio
     → AgentClient(workspaceDir) filters permissions at runtime
  → Stream response back to client
```

## Docker Deployment

When running the gateway inside Docker (`npm run docker`), agents run inside the container just like they would locally. The container image includes the agent CLIs (Devin) pre-installed. Host credentials are mounted read-only so agents can authenticate.

See `Dockerfile` for the image definition and `scripts/docker.sh` for the run script.

## Security Model Summary

The isolation system provides defense in depth through multiple layers:

| Layer | Scope |
|-------|-------|
| Agent `--sandbox` flag | OS-level file/network restrictions (for CLIs that support it) |
| HOME isolation | Prevents access to host MCP servers and config |
| Workspace permission filtering | Path-based permission denial (when workspace is set) |
| Workspace GC | No persistent state after conversation expires |

Each layer operates independently, so a failure in one does not compromise the others.
