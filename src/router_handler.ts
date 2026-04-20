import { v4 as uuidv4 } from "uuid";
import { Registry } from "./registry.js";
import { Runtime, type StreamChunk, type IsolationMode } from "./runtime.js";
import { log } from "./logger.js";
import {
  normalizeIncomingMessages,
  messagesToPrompt,
  type Message,
  type ToolDef,
} from "./utils.js";
import { WorkspaceManager } from "./workspace.js";
import type { TrackedFile } from "./client.js";
import {
  prepareBridge,
  collectToolCalls,
  cleanupBridge,
  toOpenAIToolCalls,
  TOOL_BRIDGE_SYSTEM_PROMPT,
  type OpenAITool,
  type OpenAIToolCall,
} from "./tool_bridge.js";

/**
 * Default system prompt injected before the conversation to make the agent
 * behave as a standard LLM endpoint. Override via GATEWAY_SYSTEM_PROMPT env
 * var, or set it to an empty string to disable.
 */
const GATEWAY_SYSTEM_PROMPT =
  process.env.GATEWAY_SYSTEM_PROMPT ??
  `You are a helpful AI assistant exposed through an OpenAI-compatible API.
Answer questions based on the context provided in the conversation messages.
Do NOT use tools such as shell commands, file operations, or web browsing to answer.
Respond directly from your knowledge and from any context the user provides in their messages.
Keep your answers concise and relevant.`;

/** Whether the tool bridge feature is enabled (default: true). */
const TOOL_BRIDGE_ENABLED =
  (process.env.TOOL_BRIDGE_ENABLED ?? "true").trim().toLowerCase() !== "false";

/** Collection window for batching multiple tool calls (ms). */
const TOOL_BRIDGE_WINDOW_MS = parseInt(process.env.TOOL_BRIDGE_COLLECTION_WINDOW_MS ?? "500", 10);

export interface ChatCompletionRequest {
  model?: string;
  messages?: Message[];
  stream?: boolean;
  tools?: ToolDef[];
  // Extra params that map to optional_params
  [key: string]: unknown;
}

export interface ArtifactInfo {
  token: string;
  files: string[];
  base_url: string;
}

export interface ChatCompletionResponse {
  id: string;
  created: number;
  model: string;
  object: string;
  choices: Array<{
    finish_reason: string;
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Workspace artifacts produced by the agent. */
  artifacts?: ArtifactInfo;
  /** Conversation ID for multi-turn persistence. */
  conversation_id?: string;
}

export interface StreamingContext {
  conversationId: string;
  token: string;
  trackedFiles: () => TrackedFile[];
  workspaceDir: string;
}

/**
 * Check if a request has OpenAI-style tool definitions that should
 * activate the tool bridge.
 */
function hasClientTools(tools: ToolDef[] | undefined): tools is OpenAITool[] {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return false;
  return tools.some(
    (t) => typeof t === "object" && t !== null && t.type === "function" && t.function?.name,
  );
}

export class RouterHandler {
  registry: Registry;
  runtime: Runtime;
  workspaces: WorkspaceManager;

  constructor(registry: Registry, workspaces?: WorkspaceManager, isolationMode?: IsolationMode) {
    this.registry = registry;
    this.runtime = new Runtime(isolationMode);
    this.workspaces = workspaces ?? new WorkspaceManager();
  }

  /**
   * Streaming with workspace integration.
   * Returns both the stream chunks and context for building the response.
   */
  streamingWithContext(
    body: ChatCompletionRequest,
    conversationId?: string,
  ): {
    chunks: AsyncGenerator<StreamChunk>;
    context: StreamingContext;
  } {
    const model = body.model ?? "acp/kimi";
    const optionalParams = (body as Record<string, unknown>) ?? {};
    const messages = body.messages ?? normalizeIncomingMessages(body as Record<string, unknown>);
    const tools = body.tools;

    const { adapter, modelId } = this.registry.resolve(model, optionalParams);
    const spec = adapter.buildSpec(optionalParams);
    if (modelId) spec.modelId = modelId;
    log.debug(
      `  request: model=${model} → adapter=${adapter.agentId}, modelId=${spec.modelId ?? "(none)"}`,
    );

    // Get or create workspace
    const ws = this.workspaces.getOrCreate(conversationId);

    // Materialize uploaded files into workspace
    const uploadedFiles = this.workspaces.materializeFiles(
      ws,
      messages as Array<{ role?: string; content?: unknown }>,
    );

    // Check if tool bridge should be activated
    const useBridge = TOOL_BRIDGE_ENABLED && hasClientTools(tools);

    // Choose system prompt: tool bridge prompt when tools are present,
    // otherwise the default gateway prompt
    const systemPrompt = useBridge ? TOOL_BRIDGE_SYSTEM_PROMPT : GATEWAY_SYSTEM_PROMPT;

    // Prepend system prompt if configured
    const allMessages: Message[] = [];
    if (systemPrompt) {
      allMessages.push({ role: "system", content: systemPrompt });
    }
    allMessages.push(...messages);

    // Build prompt — omit tool hints when bridge is active (tools are MCP now)
    const promptTools = useBridge ? undefined : tools;
    let promptText = messagesToPrompt(allMessages, promptTools) || "User: Hello";
    if (uploadedFiles.length > 0) {
      promptText += `\n\nUploaded files (available in CWD):\n${uploadedFiles.map((f) => `- ${f}`).join("\n")}`;
    }

    // Set up MCP bridge if tools are present
    let bridgeSetup: ReturnType<typeof prepareBridge> | undefined;
    if (useBridge) {
      const containerCwd = this.runtime.isolationMode === "docker" ? "/workspace" : undefined;
      bridgeSetup = prepareBridge(tools, ws.dir, containerCwd);
      // Inject the bridge MCP server into optional params (for newSession)
      const existingMcp = (optionalParams.mcp_servers as unknown[]) ?? [];
      optionalParams.mcp_servers = [...existingMcp, bridgeSetup.mcpServer];
      // Pass the host-side config path so the runtime can mount it into the
      // container at the agent's standard config location.
      optionalParams._bridge_host_config_path = bridgeSetup.hostConfigPath;
      log.debug(`  tool bridge: activated with ${tools.length} tool(s)`);
    }

    const { stream, client, kill } = this.runtime.runStreamWithClient({
      spec,
      promptText,
      optionalParams,
      messages,
      cwd: ws.dir,
      homeDir: ws.homeDir,
    });

    const context: StreamingContext = {
      conversationId: ws.conversationId,
      token: ws.token,
      trackedFiles: () => client.trackedFiles,
      workspaceDir: ws.dir,
    };

    if (bridgeSetup) {
      // Wrap the stream to intercept tool calls
      const wrappedStream = this.wrapStreamWithBridge(stream, bridgeSetup, kill);
      return { chunks: wrappedStream, context };
    }

    return { chunks: stream, context };
  }

  /**
   * Wrap a stream to monitor for tool bridge signals.
   * Consumes text chunks normally, but races each stream iteration against
   * the tool call collection promise. When tool calls are detected (even if
   * the stream is blocked waiting for more chunks), yields a final chunk
   * with tool_calls and stops.
   */
  private async *wrapStreamWithBridge(
    stream: AsyncGenerator<StreamChunk>,
    bridge: ReturnType<typeof prepareBridge>,
    kill: () => void,
  ): AsyncGenerator<StreamChunk> {
    const textParts: string[] = [];
    let toolCallsDetected = false;
    let collectedToolCalls: Awaited<ReturnType<typeof collectToolCalls>> = [];

    // Start monitoring for tool calls in parallel
    const toolCallPromise = collectToolCalls(bridge.signalDir, TOOL_BRIDGE_WINDOW_MS);

    // Track when tool calls resolve (for synchronous check between races)
    let toolCallsReady = false;
    let resolvedCalls: typeof collectedToolCalls = [];
    toolCallPromise.then((calls) => {
      toolCallsReady = true;
      resolvedCalls = calls;
    });

    const iterator = stream[Symbol.asyncIterator]();

    try {
      while (true) {
        // Race the next stream chunk against tool call collection.
        // This ensures we break out promptly when the agent is stuck
        // waiting for a tool response from the bridge.
        const result = await Promise.race([
          iterator.next().then((r) => ({ type: "chunk" as const, ...r })),
          toolCallPromise.then((calls) => ({ type: "tools" as const, calls })),
        ]);

        if (result.type === "tools" && result.calls.length > 0) {
          collectedToolCalls = result.calls;
          toolCallsDetected = true;
          break;
        }

        if (result.type === "chunk") {
          if (result.done) break;
          const chunk = result.value;

          // Before yielding, check if tool calls arrived during iteration
          if (toolCallsReady && resolvedCalls.length > 0) {
            if (chunk.text) textParts.push(chunk.text);
            collectedToolCalls = resolvedCalls;
            toolCallsDetected = true;
            break;
          }

          if (chunk.text) textParts.push(chunk.text);
          if (!chunk.is_finished) {
            yield chunk;
          }
        }
      }

      // If stream ended naturally, give a short window for late-arriving signals
      if (!toolCallsDetected) {
        const finalCalls = await Promise.race([
          toolCallPromise,
          new Promise<never[]>((r) => setTimeout(() => r([]), 100)),
        ]);
        if (finalCalls.length > 0) {
          collectedToolCalls = finalCalls;
          toolCallsDetected = true;
        }
      }
    } finally {
      // Clean up bridge files immediately (we already have the signals)
      cleanupBridge(bridge.bridgeDir);
      // Kill the agent process directly. This is necessary because when
      // Promise.race picks toolCallPromise, iterator.next() is still pending
      // and iterator.return() would be queued behind it, causing a long delay
      // (or never completing) while the agent keeps producing chunks.
      // By killing the process first, the pending iterator.next() resolves
      // quickly, and iterator.return() can clean up immediately.
      kill();
      await iterator.return?.(undefined).catch(() => {});
    }

    if (toolCallsDetected && collectedToolCalls.length > 0) {
      // Yield final chunk with tool_calls
      const openAIToolCalls = toOpenAIToolCalls(collectedToolCalls);
      log.debug(
        `  tool bridge: returning ${openAIToolCalls.length} tool call(s): ${openAIToolCalls.map((t) => t.function.name).join(", ")}`,
      );
      yield {
        finish_reason: "tool_calls",
        index: 0,
        is_finished: true,
        text: textParts.join(""),
        tool_calls: openAIToolCalls,
        tool_use: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    } else {
      // No tool calls — yield normal finish
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

  async *streaming(body: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    const { chunks } = this.streamingWithContext(body);
    yield* chunks;
  }

  async completion(
    body: ChatCompletionRequest,
    conversationId?: string,
  ): Promise<ChatCompletionResponse> {
    const model = body.model ?? "acp/kimi";
    const { chunks, context } = this.streamingWithContext(body, conversationId);
    const parts: string[] = [];
    let toolCalls: OpenAIToolCall[] | undefined;
    let finishReason = "stop";

    for await (const chunk of chunks) {
      if (chunk.text) parts.push(chunk.text);
      if (chunk.tool_calls) {
        toolCalls = chunk.tool_calls;
        finishReason = "tool_calls";
      }
    }

    const outputText =
      parts.join("").trim() || (toolCalls ? "" : "No final assistant text captured from router.");

    // Collect workspace files for artifact info
    const ws = this.workspaces.getOrCreate(context.conversationId);
    const allFiles = this.workspaces.listFiles(ws);

    const message: { role: string; content: string; tool_calls?: OpenAIToolCall[] } = {
      role: "assistant",
      content: outputText,
    };
    if (toolCalls) message.tool_calls = toolCalls;

    const response: ChatCompletionResponse = {
      id: `chatcmpl-${uuidv4().replace(/-/g, "")}`,
      created: Math.floor(Date.now() / 1000),
      model,
      object: "chat.completion",
      choices: [
        {
          finish_reason: finishReason,
          index: 0,
          message,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      conversation_id: context.conversationId,
    };

    if (allFiles.length > 0) {
      response.artifacts = {
        token: context.token,
        files: allFiles,
        base_url: `/v1/artifacts/${context.token}`,
      };
    }

    return response;
  }
}
