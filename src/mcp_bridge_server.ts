/**
 * MCP Bridge Server — a minimal MCP-compatible server that exposes
 * client-provided tools to an ACP agent and signals tool calls back
 * to the gateway via JSON files in a signaling directory.
 *
 * Spawned as a child process by the ACP agent (via McpServerStdio).
 * Speaks JSON-RPC 2.0 over stdio (newline-delimited JSON).
 *
 * Environment variables:
 *   BRIDGE_TOOLS_JSON  — JSON array of MCP tool definitions
 *   BRIDGE_SIGNAL_DIR  — directory to write tool call signal files
 *
 * When the agent calls a tool, this script:
 *   1. Writes a JSON file to BRIDGE_SIGNAL_DIR with the call details
 *   2. Never responds (blocks forever) — the gateway kills the agent
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ToolCallSignal {
  name: string;
  arguments: Record<string, unknown>;
  callId: string;
  timestamp: number;
}

// Resolve the directory this script lives in (for fallback config files)
const scriptDir = dirname(fileURLToPath(import.meta.url));

/**
 * Read config from env vars first, then fall back to files in the script
 * directory. This handles agents that don't forward env vars from the
 * McpServerStdio config to the spawned process.
 */
function readConfig(): { tools: McpTool[]; signalDir: string } {
  let toolsJson = process.env.BRIDGE_TOOLS_JSON ?? "";
  let sig = process.env.BRIDGE_SIGNAL_DIR ?? "";

  // Fall back to config files next to the script
  if (!toolsJson) {
    const toolsFile = join(scriptDir, "tools.json");
    if (existsSync(toolsFile)) {
      toolsJson = readFileSync(toolsFile, "utf-8");
    }
  }
  if (!sig) {
    const configFile = join(scriptDir, "config.json");
    if (existsSync(configFile)) {
      const cfg = JSON.parse(readFileSync(configFile, "utf-8")) as { signalDir?: string };
      sig = cfg.signalDir ?? "";
    }
  }

  return {
    tools: JSON.parse(toolsJson || "[]") as McpTool[],
    signalDir: sig || join(scriptDir, "signals"),
  };
}

const { tools, signalDir } = readConfig();

// Log diagnostics to stderr (visible in agent logs)
process.stderr.write(
  `[bridge] started: tools=${tools.length}, signalDir=${signalDir}, ` +
    `envTools=${process.env.BRIDGE_TOOLS_JSON ? "yes" : "no"}, ` +
    `envSignal=${process.env.BRIDGE_SIGNAL_DIR ? "yes" : "no"}, ` +
    `scriptDir=${scriptDir}\n`,
);

mkdirSync(signalDir, { recursive: true });

let signalCounter = 0;

function sendResponse(id: number | string, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function handleRequest(req: JsonRpcRequest): void {
  process.stderr.write(`[bridge] request: ${req.method} (id=${req.id})\n`);
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion:
          (req.params as { protocolVersion?: string })?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "acp-gateway-tool-bridge", version: "1.0.0" },
      });
      break;

    case "tools/list":
      sendResponse(req.id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        })),
      });
      break;

    case "tools/call": {
      // Write signal file and block forever (don't respond)
      const params = req.params as { name: string; arguments?: Record<string, unknown> };
      const signal: ToolCallSignal = {
        name: params.name,
        arguments: params.arguments ?? {},
        callId: `call_${Date.now()}_${signalCounter++}`,
        timestamp: Date.now(),
      };
      const signalPath = join(signalDir, `${signal.callId}.json`);
      writeFileSync(signalPath, JSON.stringify(signal));
      // Intentionally never respond — the gateway will kill the agent process
      break;
    }

    case "notifications/cancelled":
    case "notifications/initialized":
      // Notifications don't need a response
      break;

    case "ping":
      sendResponse(req.id, {});
      break;

    default:
      // Unknown method — respond with error
      if (req.id !== undefined && req.id !== null) {
        const msg = JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
        process.stdout.write(msg + "\n");
      }
  }
}

// Read JSON-RPC messages from stdin (newline-delimited)
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed) as JsonRpcRequest;
    if (msg.jsonrpc === "2.0" && msg.method) {
      handleRequest(msg);
    }
  } catch {
    // Ignore malformed lines
  }
});

// Keep the process alive
rl.on("close", () => process.exit(0));
