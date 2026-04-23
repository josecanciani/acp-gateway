import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { existsSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
} from "@agentclientprotocol/sdk";
import type { AgentSpec, DiscoveredModel } from "./schemas.js";
import { AgentClient } from "./client.js";
import { log } from "./logger.js";
import {
  contentBlocksToText,
  extractExistingPathsFromText,
  commonExistingParent,
  type Message,
} from "./utils.js";

/**
 * Filter out internal/legacy model IDs that agents expose but aren't
 * intended for end users (e.g. MODEL_GPT_5_2_HIGH, MODEL_PRIVATE_11).
 * These use an ALL_UPPERCASE_WITH_UNDERSCORES naming convention.
 */
function isInternalModelId(id: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(id);
}

/** Result of spawnAgent. */
interface SpawnedAgent {
  process: ChildProcess;
}

/**
 * All active agent processes, tracked so we can kill them on process exit.
 */
const activeAgents = new Set<SpawnedAgent>();

/** Stop a spawned agent process. */
function killAgent(agent: SpawnedAgent): void {
  activeAgents.delete(agent);
  try {
    agent.process.kill("SIGKILL");
  } catch {
    // already dead
  }
}

/** Stop all active agent processes (called on process exit). */
function cleanupAll(): void {
  for (const agent of activeAgents) {
    try {
      agent.process.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
  activeAgents.clear();
}

// Ensure all agents are cleaned up on any exit path
process.on("exit", cleanupAll);
process.on("SIGINT", () => {
  cleanupAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupAll();
  process.exit(143);
});

export interface StreamChunk {
  finish_reason: string | null;
  index: number;
  is_finished: boolean;
  text: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_use: null;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export interface RunStreamResult {
  stream: AsyncGenerator<StreamChunk>;
  /** The AgentClient instance; available for reading trackedFiles after stream completes. */
  client: AgentClient;
  /** Kill the agent process immediately (e.g. when tool calls are detected). */
  kill: () => void;
}

export class Runtime {
  constructor() {}
  /** Discover available models by spawning an agent, doing the ACP handshake, and reading the session response. */
  async discoverModels(spec: AgentSpec): Promise<DiscoveredModel[]> {
    const discoverCwd = process.cwd();
    // Suppress agent stderr during discovery — it produces verbose INFO logs
    const agent = this.spawnAgent(spec, discoverCwd, "ignore");

    const spawnError = await new Promise<Error | null>((resolve) => {
      agent.process.on("error", (err) => resolve(err));
      agent.process.stdin!.on("ready", () => resolve(null));
      setTimeout(() => resolve(null), 200);
    });

    if (spawnError) {
      killAgent(agent);
      throw new Error(`Agent binary "${spec.bin}" not found: ${spawnError.message}`);
    }

    try {
      const input = Writable.toWeb(agent.process.stdin!) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(agent.process.stdout!) as ReadableStream<Uint8Array>;
      const stream = ndJsonStream(input, output);
      const client = new AgentClient();
      const conn = new ClientSideConnection((_agent: Agent) => client as Client, stream);

      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await conn.newSession({
        cwd: discoverCwd,
        mcpServers: [],
      });
      const sessionData = session as Record<string, unknown>;

      // Try configOptions (ACP agents expose models as a "model" config option)
      const configOptions = sessionData.configOptions as
        | Array<{
            id?: string;
            category?: string;
            options?: Array<{
              value: string;
              name: string;
              description?: string;
            }>;
          }>
        | undefined;
      const modelConfig = configOptions?.find(
        (opt) => opt.category === "model" || opt.id === "model",
      );
      if (modelConfig?.options?.length) {
        return modelConfig.options
          .filter((o) => !isInternalModelId(o.value))
          .map((o) => ({
            modelId: o.value,
            name: o.name,
            description: o.description,
          }));
      }

      // Fallback: legacy models.availableModels field
      const models = sessionData.models as
        | {
            availableModels?: Array<{
              modelId: string;
              name: string;
              description?: string;
            }>;
          }
        | undefined;
      if (!models?.availableModels?.length) return [];

      return models.availableModels.map((m) => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description,
      }));
    } finally {
      killAgent(agent);
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

  /**
   * Like runStream, but also exposes the AgentClient for post-stream inspection
   * (e.g. reading trackedFiles after all chunks have been consumed).
   */
  runStreamWithClient(opts: {
    spec: AgentSpec;
    promptText: string;
    optionalParams: Record<string, unknown>;
    messages: Message[];
    cwd?: string;
    homeDir?: string;
  }): RunStreamResult {
    const cwd = opts.cwd ?? this.resolveCwd(opts.optionalParams, opts.messages);
    const client = new AgentClient(
      String(opts.optionalParams.permission_mode ?? "auto_allow")
        .trim()
        .toLowerCase(),
      cwd,
    );
    // Shared holder: the generator sets this when the agent is spawned.
    // The kill() function reads it to kill the agent directly.
    const agentRef: { current?: SpawnedAgent } = {};
    const stream = this.runStreamInternal({
      ...opts,
      cwd,
      client,
      agentRef,
    });
    const kill = () => {
      if (agentRef.current) killAgent(agentRef.current);
    };
    return { stream, client, kill };
  }

  async *runStream(opts: {
    spec: AgentSpec;
    promptText: string;
    optionalParams: Record<string, unknown>;
    messages: Message[];
    /** If provided, overrides all CWD resolution logic. */
    cwd?: string;
  }): AsyncGenerator<StreamChunk> {
    const cwd = opts.cwd ?? this.resolveCwd(opts.optionalParams, opts.messages);
    const client = new AgentClient(
      String(opts.optionalParams.permission_mode ?? "auto_allow")
        .trim()
        .toLowerCase(),
      cwd,
    );
    yield* this.runStreamInternal({ ...opts, cwd, client });
  }

  /**
   * Spawn the agent process with `--sandbox` (when supported) and HOME isolation.
   *
   * @param stderr  Where to send the child's stderr.
   *   "inherit" forwards to the gateway's stderr (default for prompts),
   *   "ignore" suppresses it (used during model discovery).
   */
  private spawnAgent(
    spec: AgentSpec,
    _hostCwd: string,
    stderr: "inherit" | "ignore" = "inherit",
    homeDir?: string,
  ): SpawnedAgent {
    const sandboxArgs = spec.sandbox ? ["--sandbox"] : [];

    // Use the conversation homeDir as HOME to isolate the agent
    // from the host's MCP servers, config, and cache.
    // If no homeDir is provided (e.g. model discovery), fall back to default.
    const env = homeDir ? { ...process.env, HOME: homeDir } : undefined;

    const agent: SpawnedAgent = {
      process: spawn(spec.bin, [...sandboxArgs, ...spec.args], {
        stdio: ["pipe", "pipe", stderr],
        ...(env && { env }),
      }),
    };
    activeAgents.add(agent);
    agent.process.on("exit", (code, signal) => {
      activeAgents.delete(agent);
      if (signal === "SIGKILL") {
        log.debug(`agent process killed (${spec.bin})`);
      } else if (code !== null && code !== 0) {
        log.warn(`agent process exited with code ${code} (${spec.bin})`);
      } else if (signal) {
        log.warn(`agent process killed by ${signal} (${spec.bin})`);
      }
    });
    return agent;
  }

  /**
   * Prepare a conversation's home directory for use as the agent's HOME.
   *
   * The directory itself is created by WorkspaceManager. This method
   * populates it with:
   * - Credentials copied from the real HOME so the agent can authenticate
   * - Bridge config (if provided) so Devin discovers MCP tools natively
   */
  private prepareAgentHome(homeDir: string, bridgeConfigPath?: string): void {
    const configDir = path.join(homeDir, ".config", "devin");
    const dataDir = path.join(homeDir, ".local", "share", "devin");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    // Copy credentials so the agent can authenticate
    const realHome = process.env.HOME ?? "/tmp";
    const credsFile =
      process.env.DEVIN_CREDENTIALS_FILE ??
      path.join(realHome, ".local", "share", "devin", "credentials.toml");
    if (existsSync(credsFile)) {
      copyFileSync(credsFile, path.join(dataDir, "credentials.toml"));
    }

    // Install bridge config so Devin finds tools
    if (bridgeConfigPath && existsSync(bridgeConfigPath)) {
      copyFileSync(bridgeConfigPath, path.join(configDir, "config.json"));
    }
  }

  private async *runStreamInternal(opts: {
    spec: AgentSpec;
    promptText: string;
    optionalParams: Record<string, unknown>;
    messages: Message[];
    cwd?: string;
    homeDir?: string;
    client: AgentClient;
    agentRef?: { current?: SpawnedAgent };
  }): AsyncGenerator<StreamChunk> {
    const { spec, promptText, optionalParams, messages, client } = opts;

    const cwd = opts.cwd ?? this.resolveCwd(optionalParams, messages);
    const mcpServers = (optionalParams.mcp_servers as unknown[]) ?? [];
    const bridgeHostConfigPath = optionalParams._bridge_host_config_path as string | undefined;

    // Prepare the agent's isolated HOME (credentials + bridge config)
    if (opts.homeDir) {
      this.prepareAgentHome(opts.homeDir, bridgeHostConfigPath);
    }

    // Spawn the agent process
    // Forward agent stderr only at debug level
    const agent = this.spawnAgent(
      spec,
      cwd,
      log.level === "debug" ? "inherit" : "ignore",
      opts.homeDir,
    );

    // Expose the agent to the caller so it can be killed externally
    // (e.g. by the tool bridge when tool calls are detected).
    if (opts.agentRef) opts.agentRef.current = agent;

    // Handle spawn errors (e.g. binary not found)
    const spawnError = await new Promise<Error | null>((resolve) => {
      agent.process.on("error", (err) => resolve(err));
      // If stdin is writable, the process started successfully
      agent.process.stdin!.on("ready", () => resolve(null));
      // Give it a moment to either start or fail
      setTimeout(() => resolve(null), 200);
    });

    if (spawnError) {
      killAgent(agent);
      throw new Error(`Failed to spawn agent "${spec.bin}": ${spawnError.message}`);
    }

    let connectionLost = false;
    try {
      const input = Writable.toWeb(agent.process.stdin!) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(agent.process.stdout!) as ReadableStream<Uint8Array>;

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
        mcpServers: mcpServers as Array<Record<string, unknown>>,
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

      // Set model if specified — try setSessionConfigOption first (stable API),
      // fall back to unstable_setSessionModel for older agents.
      if (spec.modelId) {
        let modelSet = false;
        try {
          await conn.setSessionConfigOption({
            sessionId,
            configId: "model",
            type: "boolean",
            value: spec.modelId,
          } as unknown as Parameters<typeof conn.setSessionConfigOption>[0]);
          log.debug(`  model set to ${spec.modelId} (via configOption)`);
          modelSet = true;
        } catch {
          // configOption not supported — try unstable_setSessionModel
        }
        if (!modelSet) {
          try {
            await (
              conn as unknown as {
                unstable_setSessionModel(p: {
                  sessionId: string;
                  modelId: string;
                }): Promise<unknown>;
              }
            ).unstable_setSessionModel({
              sessionId,
              modelId: spec.modelId,
            });
            log.debug(`  model set to ${spec.modelId} (via setSessionModel)`);
          } catch (err) {
            log.warn(`  failed to set model ${spec.modelId}: ${err}`);
          }
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

      // Ensure prompt completes — catch connection errors gracefully
      // so already-streamed text reaches the client with a clean finish
      // signal instead of crashing the HTTP handler mid-SSE.
      try {
        await promptPromise;
      } catch (err) {
        connectionLost = true;
        log.warn(`agent connection lost: ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      killAgent(agent);
    }

    if (connectionLost) {
      yield {
        finish_reason: null,
        index: 0,
        is_finished: false,
        text: "\n\n[Agent process ended unexpectedly]",
        tool_use: null,
        usage: null,
      };
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
