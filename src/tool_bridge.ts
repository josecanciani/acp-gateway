/**
 * Tool Bridge — translates OpenAI-style tool definitions into an MCP server
 * that an ACP agent can connect to, and collects tool call signals.
 *
 * Lifecycle:
 *   1. `prepareBridge(tools, workspaceDir)` → writes bridge script + tools config
 *   2. Returns `McpServerStdio` config for the agent's `newSession(mcpServers)`
 *   3. `collectToolCalls(signalDir, windowMs)` → watches for signal files
 *   4. After collection, caller cleans up the bridge directory
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { log } from "./logger.js";

/** OpenAI-style tool definition (from request body). */
export interface OpenAITool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** MCP tool definition (for tools/list response). */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A collected tool call from the bridge signal directory. */
export interface CollectedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** OpenAI-compatible tool_call in a response. */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Result of preparing the bridge: config for the agent + cleanup handle. */
export interface BridgeSetup {
  /** McpServerStdio config to pass to newSession. */
  mcpServer: {
    name: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  };
  /** Directory where signal files will appear. */
  signalDir: string;
  /** Directory containing all bridge files (for cleanup). */
  bridgeDir: string;
  /**
   * Host-side path to an agent config.json that includes the bridge MCP server.
   * In Docker mode, this is mounted at ~/.config/devin/config.json inside the
   * container so the agent discovers the MCP server through its native config.
   */
  hostConfigPath: string;
}

/** Path to the compiled bridge server script. */
const BRIDGE_SERVER_PATH = resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp_bridge_server.js",
);

/**
 * Convert OpenAI tool definitions to MCP tool definitions.
 */
export function openAIToolsToMcp(tools: OpenAITool[]): McpToolDef[] {
  const mcpTools: McpToolDef[] = [];
  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function?.name) continue;
    mcpTools.push({
      name: tool.function.name,
      description: tool.function.description ?? "",
      inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
    });
  }
  return mcpTools;
}

/**
 * Convert collected tool calls to OpenAI tool_calls format.
 */
export function toOpenAIToolCalls(calls: CollectedToolCall[]): OpenAIToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function",
    function: {
      name: c.name,
      arguments: JSON.stringify(c.arguments),
    },
  }));
}

/**
 * Prepare the MCP bridge for a request with tools.
 *
 * Creates a signaling directory inside the workspace, copies the bridge
 * server script there, and returns the McpServerStdio config for the agent.
 *
 * @param tools         OpenAI tool definitions from the request
 * @param workspaceDir  Host-side workspace directory
 * @param containerCwd  If set, the CWD as seen inside the container (e.g. "/workspace").
 *                      Paths in the MCP config are translated so the agent can find
 *                      the bridge script and signal directory. The returned `signalDir`
 *                      and `bridgeDir` remain host paths (the gateway reads from the host).
 */
export function prepareBridge(
  tools: OpenAITool[],
  workspaceDir: string,
  containerCwd?: string,
): BridgeSetup {
  const bridgeDir = join(workspaceDir, ".acp-tool-bridge");
  const signalDir = join(bridgeDir, "signals");
  mkdirSync(signalDir, { recursive: true });

  // Copy the bridge server script into the workspace so it's accessible
  // in any isolation mode (Docker mounts the workspace, sandbox/direct
  // can read it directly). Use .mjs extension so Node treats it as an
  // ES module regardless of the surrounding package.json.
  const bridgeScript = join(bridgeDir, "mcp_bridge_server.mjs");
  copyFileSync(BRIDGE_SERVER_PATH, bridgeScript);

  const mcpTools = openAIToolsToMcp(tools);

  // Paths as seen by the agent: translated for Docker, host paths otherwise
  const agentBridgeDir = containerCwd ? join(containerCwd, ".acp-tool-bridge") : bridgeDir;
  const agentBridgeScript = join(agentBridgeDir, "mcp_bridge_server.mjs");
  const agentSignalDir = join(agentBridgeDir, "signals");

  // Write config files next to the script as a fallback — some agents
  // don't forward the env vars from McpServerStdio to the spawned process.
  writeFileSync(join(bridgeDir, "tools.json"), JSON.stringify(mcpTools));
  writeFileSync(join(bridgeDir, "config.json"), JSON.stringify({ signalDir: agentSignalDir }));

  // Write an agent-compatible config.json that registers the bridge as an
  // MCP server. In Docker mode, the runtime mounts this at the agent's
  // standard config path (~/.config/devin/config.json) so the agent
  // discovers the tools through its native MCP integration.
  const mcpServerConfig = {
    command: "node",
    args: [agentBridgeScript],
    env: {
      BRIDGE_TOOLS_JSON: JSON.stringify(mcpTools),
      BRIDGE_SIGNAL_DIR: agentSignalDir,
    },
  };
  const agentConfig = { mcpServers: { "client-tools": mcpServerConfig } };
  const hostConfigPath = join(bridgeDir, "agent-config.json");
  writeFileSync(hostConfigPath, JSON.stringify(agentConfig));

  return {
    mcpServer: {
      name: "client-tools",
      command: "node",
      args: [agentBridgeScript],
      env: [
        { name: "BRIDGE_TOOLS_JSON", value: JSON.stringify(mcpTools) },
        { name: "BRIDGE_SIGNAL_DIR", value: agentSignalDir },
      ],
    },
    signalDir,
    bridgeDir,
    hostConfigPath,
  };
}

/**
 * Collect tool call signals from the bridge directory.
 *
 * Polls the signal directory for JSON files. After the first signal arrives,
 * waits `windowMs` for additional signals (resetting the timer on each new one).
 *
 * Returns the collected calls, or an empty array if none arrive within `timeoutMs`.
 *
 * @param signalDir   Directory to watch for signal files
 * @param windowMs    Collection window after first signal (default 500ms)
 * @param timeoutMs   Max time to wait for first signal (default 60000ms)
 */
export async function collectToolCalls(
  signalDir: string,
  windowMs = 500,
  timeoutMs = 60_000,
): Promise<CollectedToolCall[]> {
  const collected = new Map<string, CollectedToolCall>();
  const startTime = Date.now();
  let firstSignalTime: number | null = null;
  const pollInterval = 50; // ms

  while (true) {
    const elapsed = Date.now() - startTime;

    // Check overall timeout (no signals at all)
    if (firstSignalTime === null && elapsed > timeoutMs) {
      break;
    }

    // Check collection window (after first signal)
    if (firstSignalTime !== null && Date.now() - firstSignalTime > windowMs) {
      break;
    }

    // Poll for new signal files
    try {
      const files = readdirSync(signalDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        if (collected.has(file)) continue;
        try {
          const content = readFileSync(join(signalDir, file), "utf-8");
          const signal = JSON.parse(content) as {
            name: string;
            arguments: Record<string, unknown>;
            callId: string;
          };
          collected.set(file, {
            id: signal.callId,
            name: signal.name,
            arguments: signal.arguments,
          });
          // Reset window timer on each new signal
          firstSignalTime = Date.now();
          log.debug(`  tool bridge: collected ${signal.name}(${JSON.stringify(signal.arguments)})`);
        } catch {
          // Ignore malformed files
        }
      }
    } catch {
      // Signal directory may not exist yet
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return [...collected.values()];
}

/**
 * Clean up bridge files from the workspace.
 */
export function cleanupBridge(bridgeDir: string): void {
  try {
    rmSync(bridgeDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

/**
 * System prompt used when the tool bridge is active.
 * Frames the environment so the agent reaches for MCP tools instead of
 * built-in file/shell operations.
 */
export const TOOL_BRIDGE_SYSTEM_PROMPT =
  process.env.TOOL_BRIDGE_SYSTEM_PROMPT ??
  `You are a helpful AI assistant exposed through an OpenAI-compatible API.

IMPORTANT: You are operating on an EXTERNAL codebase that is NOT available locally.
There are NO project files in your working directory or anywhere on the local filesystem.
The only local files are any attachments explicitly provided in this conversation.

To access the external codebase (read files, search code, list directories, run commands, etc.),
you MUST use the tools provided via the "client-tools" MCP server.
Your built-in file operations and shell commands will NOT find any project files because
the codebase lives on a remote machine that is only accessible through the MCP tools.

Do NOT attempt to use built-in tools like read, write, exec, grep, or shell commands to
access project files — they do not exist locally. Always use the "client-tools" MCP server.

When you have enough information to answer, respond directly with your answer.`;
