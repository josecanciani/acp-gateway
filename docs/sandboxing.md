# Agent Isolation & Sandboxing

This document describes the three-tier isolation system that acp-gateway uses to constrain ACP agent subprocesses.

## Overview

When the gateway spawns an agent, it can wrap the process in an isolation layer that limits filesystem access, network reach, and other OS-level capabilities. Three modes are available — **Docker**, **Sandbox**, and **Direct** — and the gateway auto-detects the best one at startup.

On top of OS-level isolation, the `AgentClient` enforces **workspace-scoped permission filtering** in every mode, providing a baseline defense layer even when no external sandbox is present.

## Isolation Modes

| Priority | Mode | Detection | Isolation |
|----------|------|-----------|-----------|
| 1 | Docker | `docker image inspect acp-gateway-agent` succeeds | Full namespace isolation (pid, net, mount) |
| 2 | Sandbox | Default when Docker image is absent | OS-level file/network restrictions via macOS seatbelt or Linux bubblewrap+seccomp |
| 3 | Direct | Explicit opt-in or last-resort fallback | None — agent runs as a regular child process |

All three modes include workspace permission filtering (see [Workspace-Scoped Permission Filtering](#workspace-scoped-permission-filtering)).

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_ISOLATION` | Override auto-detection. Values: `docker`, `sandbox`, `direct`, `auto` | `auto` |
| `AGENT_DOCKER_IMAGE` | Docker image name for Docker mode | `acp-gateway-agent` |

### Examples

Force Docker isolation:

```bash
AGENT_ISOLATION=docker npm start
```

Use a custom Docker image:

```bash
AGENT_DOCKER_IMAGE=my-org/agent-sandbox:latest AGENT_ISOLATION=docker npm start
```

Disable all OS-level isolation (trusted local development):

```bash
AGENT_ISOLATION=direct npm start
```

## Auto-Detection Logic

The `detectIsolationMode()` function runs once at startup and selects a mode for all subsequent requests:

1. If `AGENT_ISOLATION` is set to `docker`, `sandbox`, or `direct`, use that value directly.
2. Run `docker image inspect <AGENT_DOCKER_IMAGE>` — if the command succeeds, use **Docker** mode.
3. Otherwise, fall back to **Sandbox** mode.

The detected mode is logged at startup and passed to `RouterHandler`, which forwards it to the runtime on every request.

## Docker Mode

The strongest isolation tier. The agent process runs inside a disposable container with its own pid, network, and mount namespaces.

### Container Configuration

- **Workspace mount:** The conversation workspace directory is mounted at `/workspace` inside the container.
- **Credential mounts** (read-only):

| Host path | Container path |
|-----------|---------------|
| `~/.config/devin` | `/home/agent/.config/devin` |
| `~/.local/share/devin/credentials.toml` | `/home/agent/.local/share/devin/credentials.toml` |
| `~/.local/share/devin/mcp` | `/home/agent/.local/share/devin/mcp` |

- **Container flags:**
  - `--rm` — auto-removed on exit
  - Named `acp-<random>` to avoid collisions
  - Runs with host UID:GID so files written to `/workspace` have correct ownership
  - The agent binary receives `--sandbox` inside the container (defense in depth)

### How It Fits in the Request Flow

```
Runtime.spawnAgent(spec, isolationMode)
  → docker run --rm --name acp-<id> \
      -v <workspace>:/workspace \
      -v ~/.config/devin:/home/agent/.config/devin:ro \
      ... \
      acp-gateway-agent <bin> <args> --sandbox
  → ACP connection over stdio (same as Direct mode)
```

## Sandbox Mode

The default mode when the Docker image is not available. Adds the `--sandbox` flag to the agent binary invocation, which activates the agent's built-in OS-level sandbox:

- **macOS:** Uses the seatbelt sandbox (`sandbox-exec`) to restrict filesystem and network access.
- **Linux:** Uses bubblewrap (`bwrap`) with seccomp filters.

The exact restrictions depend on the agent implementation. This mode is combined with workspace permission filtering in `client.ts` for two layers of protection.

### How It Fits in the Request Flow

```
Runtime.spawnAgent(spec, isolationMode)
  → spawn(bin, [...args, "--sandbox"])
  → ACP connection over stdio
```

## Direct Mode

No OS-level isolation. The agent binary is spawned as a regular child process, identical to the behavior before sandboxing was introduced.

This mode is appropriate for:

- Trusted local development environments
- Debugging agent behavior without sandbox interference
- Environments where neither Docker nor the agent's sandbox flag are available

Even in Direct mode, workspace permission filtering is active when a workspace directory is set.

### How It Fits in the Request Flow

```
Runtime.spawnAgent(spec, isolationMode)
  → spawn(bin, args)    // no --sandbox flag, no container
  → ACP connection over stdio
```

## Workspace-Scoped Permission Filtering

Independent of the OS-level isolation mode, the `AgentClient` implements path-based permission filtering as a baseline defense layer. This runs in all three modes.

### How It Works

1. The `AgentClient` receives the workspace directory (derived from the per-conversation workspace or CWD resolution — see [architecture.md](architecture.md)).
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
| No workspace set (Direct mode, no conversation) | Yes (filtering disabled) |

## Full Request Flow with Isolation

```
HTTP POST /v1/chat/completions
  → serve.ts (isolation mode detected at startup, passed to RouterHandler)
  → WorkspaceManager.getOrCreate(conversationId) → workspace dir
  → RouterHandler.streamingWithContext(body, workspace)
  → Registry.resolve(model) → Adapter → AgentSpec
  → Runtime.runStreamWithClient(spec, prompt, ..., cwd)
     → Runtime.spawnAgent(spec, isolationMode)
        Docker:  docker run ... acp-gateway-agent <bin> <args> --sandbox
        Sandbox: spawn(bin, [...args, "--sandbox"])
        Direct:  spawn(bin, args)
     → ACP connection over stdio
     → AgentClient(workspaceDir) filters permissions at runtime
  → Stream response back to client
```

## Security Model Summary

The isolation system provides defense in depth through multiple layers:

| Layer | Scope | Active in |
|-------|-------|-----------|
| Docker namespaces | Process, network, filesystem isolation | Docker mode only |
| Agent `--sandbox` flag | OS-level file/network restrictions | Docker mode, Sandbox mode |
| Workspace permission filtering | Path-based permission denial | All modes (when workspace is set) |
| Container auto-cleanup (`--rm`) | No persistent state after request | Docker mode only |
| Read-only credential mounts | Prevents credential tampering | Docker mode only |

Each layer operates independently, so a failure in one does not compromise the others.
