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

/**
 * Filter out internal/legacy model IDs that agents expose but aren't
 * intended for end users (e.g. MODEL_GPT_5_2_HIGH, MODEL_PRIVATE_11).
 * These use an ALL_UPPERCASE_WITH_UNDERSCORES naming convention.
 */
function isInternalModelId(id: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(id);
}

/** Result of spawnAgent — includes the container name for Docker cleanup. */
interface SpawnedAgent {
  process: ChildProcess;
  /** Docker container name (only set in docker isolation mode). */
  containerName?: string;
}

/**
 * Active Docker container names, tracked so we can stop them on process exit.
 * Containers are added when spawned and removed when killed.
 */
const activeContainers = new Set<string>();

/**
 * All active agent processes, tracked so we can kill them on process exit.
 * This covers sandbox and direct modes where there are no Docker containers.
 */
const activeAgents = new Set<SpawnedAgent>();

/** Stop a spawned agent, using `docker kill` for Docker containers. */
function killAgent(agent: SpawnedAgent): void {
  activeAgents.delete(agent);
  if (agent.containerName) {
    activeContainers.delete(agent.containerName);
    // docker kill is faster than docker stop and we don't need graceful shutdown
    spawnSync("docker", ["kill", agent.containerName], { stdio: "ignore" });
  } else {
    agent.process.kill("SIGKILL");
  }
}

/** Stop all active agents and Docker containers (called on process exit). */
function cleanupAll(): void {
  for (const agent of activeAgents) {
    if (!agent.containerName) {
      try {
        agent.process.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }
  activeAgents.clear();
  for (const name of activeContainers) {
    spawnSync("docker", ["kill", name], { stdio: "ignore" });
  }
  activeContainers.clear();
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
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export interface RunStreamResult {
  stream: AsyncGenerator<StreamChunk>;
  /** The AgentClient instance; available for reading trackedFiles after stream completes. */
  client: AgentClient;
  /** Kill the agent process immediately (e.g. when tool calls are detected). */
  kill: () => void;
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
 * Bump this when the Dockerfile, install-devin.sh, or Docker build logic changes.
 * The value is stored as a Docker label on the built image; at startup the gateway
 * compares the label against this constant and rebuilds when they differ.
 */
const AGENT_IMAGE_VERSION = "5";

const IMAGE_LABEL = "acp-gateway.version";

/**
 * Ensure the Docker agent image exists **and** is up-to-date.
 * Compares the `acp-gateway.version` label on the existing image against
 * AGENT_IMAGE_VERSION and rebuilds when they differ (or the image is missing).
 * Returns true if the image is ready, false if the build failed.
 */
export function ensureDockerImage(): boolean {
  const imageName = process.env.AGENT_DOCKER_IMAGE ?? "acp-gateway-agent";

  // Check if image exists and has the correct version label
  let needsNoCache = false;
  try {
    const result = spawnSync(
      "docker",
      ["image", "inspect", imageName, "--format", `{{index .Config.Labels "${IMAGE_LABEL}"}}`],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    );
    if (result.status === 0) {
      const currentVersion = result.stdout.trim();
      if (currentVersion === AGENT_IMAGE_VERSION) return true;
      // Version mismatch — need --no-cache so Docker rebuilds the layers
      // instead of just slapping a new label on the same cached image
      needsNoCache = true;
      if (currentVersion) {
        log.info(
          `  image ${imageName} outdated (v${currentVersion} → v${AGENT_IMAGE_VERSION}), rebuilding...`,
        );
      } else {
        log.info(`  image ${imageName} missing version label, rebuilding...`);
      }
    }
  } catch {
    // Image not found — will build below
  }

  const dockerContext = path.join(PROJECT_ROOT, "docker", "agent");
  if (!existsSync(path.join(dockerContext, "Dockerfile"))) {
    log.warn(`Docker isolation requested but Dockerfile not found at ${dockerContext}`);
    return false;
  }

  log.info(`  building image ${imageName} (v${AGENT_IMAGE_VERSION})...`);

  const buildArgs = [
    "build",
    ...(needsNoCache ? ["--no-cache"] : []),
    "--label",
    `${IMAGE_LABEL}=${AGENT_IMAGE_VERSION}`,
    "-t",
    imageName,
    dockerContext,
  ];

  if (log.level === "debug") {
    // Stream build output directly to the terminal
    const debugResult = spawnSync("docker", buildArgs, { stdio: "inherit" });
    if (debugResult.status === 0) {
      log.info(`  image ${imageName} ready (v${AGENT_IMAGE_VERSION})`);
      return true;
    }
    log.warn(`  failed to build image ${imageName}`);
    return false;
  }

  // Capture output so we can show it on failure
  const result = spawnSync("docker", buildArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.status === 0) {
    log.info(`  image ${imageName} ready (v${AGENT_IMAGE_VERSION})`);
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
        | { availableModels?: Array<{ modelId: string; name: string; description?: string }> }
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
    const stream = this.runStreamInternal({ ...opts, cwd, client, agentRef });
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
    bridgeHostConfigPath?: string,
  ): SpawnedAgent {
    if (this.isolationMode === "docker") {
      const imageName = process.env.AGENT_DOCKER_IMAGE ?? "acp-gateway-agent";
      const containerName = `acp-gateway-${randomBytes(8).toString("hex")}`;

      // Run as the container's default user (agent, UID 1000) rather than
      // the host UID. On macOS Docker Desktop handles volume permission
      // translation transparently; overriding --user with the host UID
      // (e.g. 501 on macOS) would prevent the agent from writing to its
      // home directory (/home/agent) which is owned by UID 1000.
      const dockerArgs = [
        "run",
        "--rm",
        "-i",
        "--name",
        containerName,
        "--hostname",
        "acp-agent-container",
        "-v",
        `${hostCwd}:/workspace`,
        ...this.dockerCredentialMounts(),
        ...this.dockerBridgeConfigMounts(bridgeHostConfigPath),
        imageName,
        spec.bin,
        "--sandbox",
        ...spec.args,
      ];

      activeContainers.add(containerName);
      const proc = spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", stderr] });
      const agent: SpawnedAgent = { process: proc, containerName };
      activeAgents.add(agent);
      // Remove from tracking if the container exits on its own
      proc.on("exit", () => {
        activeContainers.delete(containerName);
        activeAgents.delete(agent);
      });
      return agent;
    }

    if (this.isolationMode === "sandbox") {
      // Pass --config to Devin-like CLIs so the bridge config replaces the
      // user's personal config (prevents leaking personal MCP servers).
      // Only known CLIs support this flag; generic binaries (e.g. node for
      // mock agents) would fail on an unknown flag.
      const configArgs =
        this.supportsConfigFlag(spec.bin) && bridgeHostConfigPath
          ? ["--config", bridgeHostConfigPath]
          : [];
      const agent: SpawnedAgent = {
        process: spawn(spec.bin, ["--sandbox", ...configArgs, ...spec.args], {
          stdio: ["pipe", "pipe", stderr],
        }),
      };
      activeAgents.add(agent);
      agent.process.on("exit", () => activeAgents.delete(agent));
      return agent;
    }

    // direct mode
    const configArgs =
      this.supportsConfigFlag(spec.bin) && bridgeHostConfigPath
        ? ["--config", bridgeHostConfigPath]
        : [];
    const agent: SpawnedAgent = {
      process: spawn(spec.bin, [...configArgs, ...spec.args], { stdio: ["pipe", "pipe", stderr] }),
    };
    activeAgents.add(agent);
    agent.process.on("exit", () => activeAgents.delete(agent));
    return agent;
  }

  /**
   * Whether the agent binary supports the `--config` CLI flag.
   * Currently only Devin-like CLIs (devin, kimi) support it.
   */
  private supportsConfigFlag(bin: string): boolean {
    const name = path.basename(bin).toLowerCase();
    return name === "devin" || name === "kimi";
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

  /**
   * Build Docker volume mount flags for the tool bridge config file.
   *
   * Mounts the bridge's agent-config.json at the standard Devin user config
   * location (~/.config/devin/config.json) inside the container. This lets
   * the agent discover the bridge MCP server through its native config
   * loading rather than relying on newSession mcpServers or --config.
   */
  private dockerBridgeConfigMounts(hostConfigPath?: string): string[] {
    if (!hostConfigPath || !existsSync(hostConfigPath)) return [];
    return ["-v", `${hostConfigPath}:/home/agent/.config/devin/config.json:ro`];
  }

  private async *runStreamInternal(opts: {
    spec: AgentSpec;
    promptText: string;
    optionalParams: Record<string, unknown>;
    messages: Message[];
    cwd?: string;
    client: AgentClient;
    agentRef?: { current?: SpawnedAgent };
  }): AsyncGenerator<StreamChunk> {
    const { spec, promptText, optionalParams, messages, client } = opts;

    const cwd = opts.cwd ?? this.resolveCwd(optionalParams, messages);
    const mcpServers = (optionalParams.mcp_servers as unknown[]) ?? [];
    const bridgeHostConfigPath = optionalParams._bridge_host_config_path as string | undefined;

    // Spawn the agent process (isolation-mode aware)
    // Forward agent stderr only at debug level
    const agent = this.spawnAgent(
      spec,
      cwd,
      log.level === "debug" ? "inherit" : "ignore",
      bridgeHostConfigPath,
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

    // In Docker mode, the CWD inside the container is /workspace
    const sessionCwd = this.isolationMode === "docker" ? "/workspace" : cwd;

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
        cwd: sessionCwd,
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

      // Ensure prompt completes
      await promptPromise;
    } finally {
      killAgent(agent);
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
