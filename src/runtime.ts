import { spawn, execSync, spawnSync, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

export type IsolationMode = "docker" | "sandbox" | "direct";

export interface StreamChunk {
  finish_reason: string | null;
  index: number;
  is_finished: boolean;
  text: string;
  tool_use: null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export interface RunStreamResult {
  stream: AsyncGenerator<StreamChunk>;
  /** The AgentClient instance; available for reading trackedFiles after stream completes. */
  client: AgentClient;
}

/** Detect the best available isolation mode at startup. */
export function detectIsolationMode(): IsolationMode {
  const override = (process.env.AGENT_ISOLATION ?? "auto").trim().toLowerCase();
  if (override === "docker" || override === "sandbox" || override === "direct") return override;

  // Docker: requires the daemon to be reachable
  try {
    execSync("docker info", { stdio: "ignore" });
    return "docker";
  } catch {
    // Docker not available
  }

  // Sandbox: available on macOS (seatbelt) and Linux (bwrap).
  // We don't probe here — Devin itself fails closed if unavailable.
  return "sandbox";
}

/** Project root directory (parent of dist/). */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ensure the Docker agent image exists, building it if necessary.
 * Should be called at startup when isolation mode is "docker".
 * Returns true if the image is ready, false if the build failed.
 */
export function ensureDockerImage(): boolean {
  const imageName = process.env.AGENT_DOCKER_IMAGE ?? "acp-gateway-agent";

  // Check if image already exists
  try {
    execSync(`docker image inspect ${imageName} --format "{{.Id}}"`, { stdio: "ignore" });
    return true;
  } catch {
    // Image not found — try to build it
  }

  const dockerContext = path.join(PROJECT_ROOT, "docker", "agent");
  if (!existsSync(path.join(dockerContext, "Dockerfile"))) {
    log.warn(`Docker isolation requested but Dockerfile not found at ${dockerContext}`);
    return false;
  }

  log.info(`  building image ${imageName}...`);
  if (log.level === "debug") {
    // Stream build output directly to the terminal
    try {
      execSync(`docker build -t ${imageName} ${dockerContext}`, { stdio: "inherit" });
      log.info(`  image ${imageName} ready`);
      return true;
    } catch {
      log.warn(`  failed to build image ${imageName}`);
      return false;
    }
  }

  // Capture output so we can show it on failure
  const result = spawnSync("docker", ["build", "-t", imageName, dockerContext], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.status === 0) {
    log.info(`  image ${imageName} ready`);
    return true;
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  log.warn(`  failed to build image ${imageName}`);
  if (output) {
    log.warn("  docker build output:");
    for (const line of output.split("\n").slice(-30)) {
      log.warn(`    ${line}`);
    }
  }
  return false;
}

export class Runtime {
  isolationMode: IsolationMode;

  constructor(isolationMode?: IsolationMode) {
    this.isolationMode = isolationMode ?? "direct";
  }
  /** Discover available models by spawning an agent, doing the ACP handshake, and reading the session response. */
  async discoverModels(spec: AgentSpec): Promise<DiscoveredModel[]> {
    const discoverCwd = process.cwd();
    // Suppress agent stderr during discovery — it produces verbose INFO logs
    const agentProcess = this.spawnAgent(spec, discoverCwd, "ignore");

    const spawnError = await new Promise<Error | null>((resolve) => {
      agentProcess.on("error", (err) => resolve(err));
      agentProcess.stdin!.on("ready", () => resolve(null));
      setTimeout(() => resolve(null), 200);
    });

    if (spawnError) throw new Error(`Agent binary "${spec.bin}" not found: ${spawnError.message}`);

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

      const session = await conn.newSession({
        cwd: this.isolationMode === "docker" ? "/workspace" : discoverCwd,
        mcpServers: [],
      });
      const sessionData = session as Record<string, unknown>;

      // Try configOptions (ACP agents expose models as a "model" config option)
      const configOptions = sessionData.configOptions as
        | Array<{
            id?: string;
            category?: string;
            options?: Array<{ value: string; name: string; description?: string }>;
          }>
        | undefined;
      const modelConfig = configOptions?.find(
        (opt) => opt.category === "model" || opt.id === "model",
      );
      if (modelConfig?.options?.length) {
        return modelConfig.options.map((o) => ({
          modelId: o.value,
          name: o.name,
          description: o.description,
        }));
      }

      // Fallback: legacy models.availableModels field
      const models = sessionData.models as
        | { availableModels?: Array<{ modelId: string; name: string; description?: string }> }
        | undefined;
      if (!models?.availableModels?.length) return [];

      return models.availableModels.map((m) => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description,
      }));
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
  }): RunStreamResult {
    const cwd = opts.cwd ?? this.resolveCwd(opts.optionalParams, opts.messages);
    const client = new AgentClient(
      String(opts.optionalParams.permission_mode ?? "auto_allow")
        .trim()
        .toLowerCase(),
      cwd,
    );
    const stream = this.runStreamInternal({ ...opts, cwd, client });
    return { stream, client };
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
   * Spawn the agent process according to the current isolation mode.
   *
   * - direct:  spawn(bin, args)
   * - sandbox: spawn(bin, ["--sandbox", ...args])
   * - docker:  spawn("docker", ["run", ..., image, bin, ...args])
   *
   * @param stderr  Where to send the child's stderr.
   *   "inherit" forwards to the gateway's stderr (default for prompts),
   *   "ignore" suppresses it (used during model discovery).
   */
  private spawnAgent(
    spec: AgentSpec,
    hostCwd: string,
    stderr: "inherit" | "ignore" = "inherit",
  ): ChildProcess {
    if (this.isolationMode === "docker") {
      const imageName = process.env.AGENT_DOCKER_IMAGE ?? "acp-gateway-agent";
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      const containerName = `acp-${randomBytes(8).toString("hex")}`;

      const dockerArgs = [
        "run",
        "--rm",
        "-i",
        "--name",
        containerName,
        "--hostname",
        "acp-agent-container",
        "--user",
        `${uid}:${gid}`,
        "-v",
        `${hostCwd}:/workspace`,
        ...this.dockerCredentialMounts(),
        imageName,
        spec.bin,
        "--sandbox",
        ...spec.args,
      ];

      return spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", stderr] });
    }

    if (this.isolationMode === "sandbox") {
      return spawn(spec.bin, ["--sandbox", ...spec.args], {
        stdio: ["pipe", "pipe", stderr],
      });
    }

    // direct mode
    return spawn(spec.bin, spec.args, { stdio: ["pipe", "pipe", stderr] });
  }

  /**
   * Build Docker volume mount flags for the Devin credentials file.
   *
   * Only the authentication token is mounted — the host config.json contains
   * macOS-specific paths (MCP servers, permissions) that don't apply inside
   * the container, and mounting the whole ~/.local/share/devin/ directory
   * would expose host-native (Mach-O) binaries that cause "Exec format error".
   */
  private dockerCredentialMounts(): string[] {
    const home = process.env.HOME ?? "/tmp";

    const credsFile =
      process.env.DEVIN_CREDENTIALS_FILE ??
      path.join(home, ".local", "share", "devin", "credentials.toml");
    if (existsSync(credsFile)) {
      return ["-v", `${credsFile}:/home/agent/.local/share/devin/credentials.toml:ro`];
    }

    return [];
  }

  private async *runStreamInternal(opts: {
    spec: AgentSpec;
    promptText: string;
    optionalParams: Record<string, unknown>;
    messages: Message[];
    cwd?: string;
    client: AgentClient;
  }): AsyncGenerator<StreamChunk> {
    const { spec, promptText, optionalParams, messages, client } = opts;

    const cwd = opts.cwd ?? this.resolveCwd(optionalParams, messages);
    const mcpServers = (optionalParams.mcp_servers as unknown[]) ?? [];

    // Spawn the agent process (isolation-mode aware)
    // Forward agent stderr only at debug level
    const agentProcess = this.spawnAgent(spec, cwd, log.level === "debug" ? "inherit" : "ignore");

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

    // In Docker mode, the CWD inside the container is /workspace
    const sessionCwd = this.isolationMode === "docker" ? "/workspace" : cwd;

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
        cwd: sessionCwd,
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
