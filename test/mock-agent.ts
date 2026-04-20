#!/usr/bin/env node
/**
 * Mock ACP agent for integration testing.
 *
 * Speaks the ACP protocol over stdio, returning deterministic responses.
 * Spawned as a subprocess by the router during tests.
 *
 * Behaviour is controlled by the prompt text:
 *   - Contains "echo:"  -> echoes everything after "echo:" back
 *   - Contains "prompt:" -> echoes the full prompt text (for system prompt testing)
 *   - Contains "mcp-tool:" -> calls the named MCP tool (format: "mcp-tool: name args_json")
 *   - Contains "error"  -> throws an error during prompt
 *   - Contains "slow"   -> waits 2 s before responding
 *   - Contains "multi"  -> sends two message chunks
 *   - Contains "permission" -> requests permission before responding
 *   - Contains "file:"  -> creates a file and reports it via tool_call
 *   - Otherwise          -> replies with "mock-response"
 */
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type AuthenticateRequest,
  type SetSessionModeRequest,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import crypto from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractPromptText(prompt: PromptRequest["prompt"]): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null && "text" in block)
        return String((block as { text: string }).text);
      return "";
    })
    .join("")
    .trim();
}

/** A connected MCP server process with JSON-RPC communication. */
interface McpConnection {
  process: ChildProcess;
  nextId: number;
  pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
}

/** Spawn and connect to an MCP server via stdio. */
function connectMcpServer(config: {
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
}): McpConnection {
  const envVars: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const { name, value } of config.env ?? []) {
    envVars[name] = value;
  }

  const proc = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: envVars,
  });

  const conn: McpConnection = {
    process: proc,
    nextId: 1,
    pendingRequests: new Map(),
  };

  // Read responses from stdout
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line.trim()) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined) {
        const pending = conn.pendingRequests.get(msg.id);
        if (pending) {
          conn.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(JSON.stringify(msg.error)));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch {
      // ignore
    }
  });

  return conn;
}

/** Send a JSON-RPC request to an MCP server and wait for the response. */
function mcpRequest(conn: McpConnection, method: string, params?: unknown): Promise<unknown> {
  const id = conn.nextId++;
  return new Promise((resolve, reject) => {
    conn.pendingRequests.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    conn.process.stdin!.write(msg + "\n");
    // Timeout after 5 seconds
    setTimeout(() => {
      if (conn.pendingRequests.has(id)) {
        conn.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }
    }, 5000);
  });
}

class MockAgent implements Agent {
  private connection: AgentSideConnection;
  private sessions = new Map<
    string,
    { pendingPrompt: AbortController | null; cwd: string; mcpConnections: McpConnection[] }
  >();

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomId();
    const rawParams = params as Record<string, unknown>;
    const cwd = (rawParams.cwd as string) ?? process.cwd();

    // Connect to any MCP servers passed in the session
    const mcpConnections: McpConnection[] = [];
    const mcpServers = rawParams.mcpServers as
      | Array<{
          name: string;
          command?: string;
          args?: string[];
          env?: Array<{ name: string; value: string }>;
        }>
      | undefined;
    if (mcpServers) {
      for (const server of mcpServers) {
        if (server.command) {
          const conn = connectMcpServer({
            command: server.command,
            args: server.args ?? [],
            env: server.env,
          });
          // Initialize the MCP connection
          await mcpRequest(conn, "initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "mock-agent", version: "1.0.0" },
          });
          mcpConnections.push(conn);
        }
      }
    }

    this.sessions.set(sessionId, { pendingPrompt: null, cwd, mcpConnections });
    return {
      sessionId,
      models: {
        currentModelId: "mock-model-a",
        availableModels: [
          { modelId: "mock-model-a", name: "Mock Model A" },
          { modelId: "mock-model-b", name: "Mock Model B", description: "A test model" },
        ],
      },
    } as NewSessionResponse;
  }

  async authenticate(_params: AuthenticateRequest): Promise<Record<string, unknown>> {
    return {};
  }

  async setSessionMode(_params: SetSessionModeRequest): Promise<Record<string, unknown>> {
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    const text = extractPromptText(params.prompt);

    try {
      if (text.includes("error")) {
        throw new Error("mock agent error");
      }

      if (text.includes("slow")) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (text.includes("multi")) {
        await this.sendText(params.sessionId, "chunk-1");
        await this.sendText(params.sessionId, "chunk-2");
      } else if (text.includes("file:")) {
        // Create a file in the session CWD and report via tool_call
        const filename = text.split("file:")[1].trim().split(/\s/)[0] || "output.txt";
        const filePath = path.join(session.cwd, filename);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, `content of ${filename}`);

        // Send tool_call update with location
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `call_${randomId().slice(0, 8)}`,
            title: `Created ${filename}`,
            kind: "edit",
            status: "completed",
            locations: [{ path: filePath }],
          },
        });

        await this.sendText(params.sessionId, `created ${filename}`);
      } else if (text.includes("mcp-tool:")) {
        // Call an MCP tool: "mcp-tool: tool_name {args_json}"
        const mcpPart = text.split("mcp-tool:")[1].trim();
        const spaceIdx = mcpPart.indexOf(" ");
        const toolName = spaceIdx > -1 ? mcpPart.slice(0, spaceIdx) : mcpPart;
        const argsStr = spaceIdx > -1 ? mcpPart.slice(spaceIdx + 1).trim() : "{}";
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsStr);
        } catch {
          // ignore parse errors
        }

        // Send text before calling tool (to test text + tool_calls)
        await this.sendText(params.sessionId, `calling ${toolName}`);

        // Call the tool on all connected MCP servers
        for (const conn of session.mcpConnections) {
          // This will block forever because the bridge never responds
          // The gateway should kill us before the timeout
          try {
            await mcpRequest(conn, "tools/call", { name: toolName, arguments: args });
          } catch {
            // Expected: timeout or process killed
          }
        }
      } else if (text.includes("prompt:")) {
        await this.sendText(params.sessionId, text);
      } else if (text.includes("echo:")) {
        const echoText = text.split("echo:")[1].trim();
        await this.sendText(params.sessionId, echoText);
      } else if (text.includes("permission")) {
        const permPath = path.join(session.cwd, "test-file.txt");
        const resp = await this.connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: "call_test",
            title: "Test operation",
            kind: "edit",
            status: "pending",
            locations: [{ path: permPath }],
            rawInput: { path: permPath },
          },
          options: [
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
        });
        if (resp.outcome.outcome === "selected" && resp.outcome.optionId === "allow") {
          await this.sendText(params.sessionId, "permission-granted");
        } else {
          await this.sendText(params.sessionId, "permission-denied");
        }
      } else {
        await this.sendText(params.sessionId, "mock-response");
      }
    } catch (err) {
      if (session.pendingPrompt?.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw err;
    }

    session.pendingPrompt = null;
    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  private async sendText(sessionId: string, text: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
}

const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);
new AgentSideConnection((conn) => new MockAgent(conn), stream);
