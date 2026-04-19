import { v4 as uuidv4 } from "uuid";
import { Registry } from "./registry.js";
import { Runtime, type StreamChunk } from "./runtime.js";
import {
  normalizeIncomingMessages,
  messagesToPrompt,
  type Message,
  type ToolDef,
} from "./utils.js";
import { WorkspaceManager } from "./workspace.js";
import type { TrackedFile } from "./client.js";

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
    message: { role: string; content: string };
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

export class RouterHandler {
  registry: Registry;
  runtime: Runtime;
  workspaces: WorkspaceManager;

  constructor(registry: Registry, workspaces?: WorkspaceManager) {
    this.registry = registry;
    this.runtime = new Runtime();
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

    // Get or create workspace
    const ws = this.workspaces.getOrCreate(conversationId);

    // Materialize uploaded files into workspace
    const uploadedFiles = this.workspaces.materializeFiles(
      ws,
      messages as Array<{ role?: string; content?: unknown }>,
    );

    // Build prompt, mentioning uploaded files if any
    let promptText = messagesToPrompt(messages, tools) || "User: Hello";
    if (uploadedFiles.length > 0) {
      promptText += `\n\nUploaded files (available in CWD):\n${uploadedFiles.map((f) => `- ${f}`).join("\n")}`;
    }

    const { stream, client } = this.runtime.runStreamWithClient({
      spec,
      promptText,
      optionalParams,
      messages,
      cwd: ws.dir,
    });

    const context: StreamingContext = {
      conversationId: ws.conversationId,
      token: ws.token,
      trackedFiles: () => client.trackedFiles,
      workspaceDir: ws.dir,
    };

    return { chunks: stream, context };
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

    for await (const chunk of chunks) {
      const text = chunk.text;
      if (text) parts.push(text);
    }

    const outputText = parts.join("").trim() || "No final assistant text captured from router.";

    // Collect workspace files for artifact info
    const ws = this.workspaces.getOrCreate(context.conversationId);
    const allFiles = this.workspaces.listFiles(ws);

    const response: ChatCompletionResponse = {
      id: `chatcmpl-${uuidv4().replace(/-/g, "")}`,
      created: Math.floor(Date.now() / 1000),
      model,
      object: "chat.completion",
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { role: "assistant", content: outputText },
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
