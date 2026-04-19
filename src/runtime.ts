import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
} from "@agentclientprotocol/sdk";
import type { AgentSpec, DiscoveredModel } from "./schemas.js";
import { AgentClient } from "./client.js";
import {
  contentBlocksToText,
  extractExistingPathsFromText,
  commonExistingParent,
  type Message,
} from "./utils.js";

export interface StreamChunk {
  finish_reason: string | null;
  index: number;
  is_finished: boolean;
  text: string;
  tool_use: null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export class Runtime {
  /** Discover available models by spawning an agent, doing the ACP handshake, and reading the session response. */
  async discoverModels(spec: AgentSpec): Promise<DiscoveredModel[]> {
    const agentProcess = spawn(spec.bin, spec.args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const spawnError = await new Promise<Error | null>((resolve) => {
      agentProcess.on("error", (err) => resolve(err));
      agentProcess.stdin!.on("ready", () => resolve(null));
      setTimeout(() => resolve(null), 200);
    });

    if (spawnError) return [];

    try {
      const input = Writable.toWeb(agentProcess.stdin!) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;
      const stream = ndJsonStream(input, output);
      const client = new AgentClient();
      const conn = new ClientSideConnection((_agent: Agent) => client as Client, stream);

      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
      const models = (session as Record<string, unknown>).models as
        | { availableModels?: Array<{ modelId: string; name: string; description?: string }> }
        | undefined;

      if (!models?.availableModels?.length) return [];

      return models.availableModels.map((m) => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description,
      }));
    } catch {
      return [];
    } finally {
      agentProcess.kill();
    }
  }

  resolveCwd(optionalParams: Record<string, unknown>, messages: Message[]): string {
    const metadata = (optionalParams.metadata ?? {}) as Record<string, unknown>;

    for (const source of [optionalParams, metadata]) {
      if (typeof source !== "object" || source === null) continue;
      for (const key of ["cwd", "workspace_path", "project_root", "root_dir", "path"]) {
        const value = (source as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) {
          try {
            const { existsSync, realpathSync } = require("node:fs");
            const p = value.startsWith("~") ? value.replace("~", process.env.HOME ?? "") : value;
            if (existsSync(p)) return realpathSync(p);
          } catch {
            // ignore
          }
        }
      }
    }

    const textBlobs: string[] = [];
    for (const msg of messages ?? []) {
      const content = contentBlocksToText(msg.content);
      if (content) textBlobs.push(content);
    }

    const foundPaths: string[] = [];
    for (const blob of textBlobs) {
      foundPaths.push(...extractExistingPathsFromText(blob));
    }

    const inferred = commonExistingParent(foundPaths);
    if (inferred) return inferred;

    return process.cwd();
  }

  async bootstrapAgentSession(
    conn: ClientSideConnection,
    sessionId: string,
    client: AgentClient,
    spec: AgentSpec,
  ): Promise<void> {
    if (!spec.bootstrapCommands.length) return;

    client.suppressStream = true;
    try {
      for (const cmd of spec.bootstrapCommands) {
        const trimmed = cmd.trim();
        if (!trimmed) continue;
        await conn.prompt({
          sessionId,
          prompt: [{ type: "text", text: trimmed }],
        });
      }
    } finally {
      client.suppressStream = false;
    }
  }

  async *runStream(opts: {
    spec: AgentSpec;
    promptText: string;
    optionalParams: Record<string, unknown>;
    messages: Message[];
  }): AsyncGenerator<StreamChunk> {
    const { spec, promptText, optionalParams, messages } = opts;
    const permissionMode = String(optionalParams.permission_mode ?? "auto_allow");

    const cwd = this.resolveCwd(optionalParams, messages);
    const mcpServers = (optionalParams.mcp_servers as unknown[]) ?? [];

    const client = new AgentClient(permissionMode);

    // Spawn the agent process
    const agentProcess = spawn(spec.bin, spec.args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    // Handle spawn errors (e.g. binary not found)
    const spawnError = await new Promise<Error | null>((resolve) => {
      agentProcess.on("error", (err) => resolve(err));
      // If stdin is writable, the process started successfully
      agentProcess.stdin!.on("ready", () => resolve(null));
      // Give it a moment to either start or fail
      setTimeout(() => resolve(null), 200);
    });

    if (spawnError) {
      throw new Error(`Failed to spawn agent "${spec.bin}": ${spawnError.message}`);
    }

    try {
      const input = Writable.toWeb(agentProcess.stdin!) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;

      const stream = ndJsonStream(input, output);
      const conn = new ClientSideConnection((_agent: Agent) => client as Client, stream);

      // Initialize
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      // Create session
      const session = await conn.newSession({
        cwd,
        mcpServers: mcpServers as Array<{ name: string; uri: string }>,
      });
      const sessionId = session.sessionId;

      // Set mode if specified
      if (spec.modeId) {
        try {
          await conn.setSessionMode({
            sessionId,
            modeId: spec.modeId,
          });
        } catch {
          // ignore if not supported
        }
      }

      // Set model if specified
      if (spec.modelId) {
        try {
          await (
            conn as unknown as {
              unstable_setSessionModel(p: { sessionId: string; modelId: string }): Promise<unknown>;
            }
          ).unstable_setSessionModel({
            sessionId,
            modelId: spec.modelId,
          });
        } catch {
          // ignore if not supported
        }
      }

      // Bootstrap
      await this.bootstrapAgentSession(conn, sessionId, client, spec);

      // Send the actual prompt (non-blocking)
      const promptPromise = conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });

      let promptDone = false;
      promptPromise
        .then(() => {
          promptDone = true;
        })
        .catch(() => {
          promptDone = true;
        });

      // Stream events from the client queue
      while (true) {
        if (promptDone && client.isEmpty) break;

        const event = await client.pullEvent(100);
        if (!event) continue;

        const text = event.text ?? "";
        if (!text) continue;

        yield {
          finish_reason: null,
          index: 0,
          is_finished: false,
          text,
          tool_use: null,
          usage: null,
        };
      }

      // Ensure prompt completes
      await promptPromise;
    } finally {
      agentProcess.kill();
    }

    yield {
      finish_reason: "stop",
      index: 0,
      is_finished: true,
      text: "",
      tool_use: null,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}
