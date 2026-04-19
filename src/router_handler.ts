import { v4 as uuidv4 } from "uuid";
import { Registry } from "./registry.js";
import { Runtime, type StreamChunk } from "./runtime.js";
import {
  normalizeIncomingMessages,
  messagesToPrompt,
  type Message,
  type ToolDef,
} from "./utils.js";

export interface ChatCompletionRequest {
  model?: string;
  messages?: Message[];
  stream?: boolean;
  tools?: ToolDef[];
  // Extra params that map to optional_params
  [key: string]: unknown;
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
}

export class RouterHandler {
  registry: Registry;
  runtime: Runtime;

  constructor(registry: Registry) {
    this.registry = registry;
    this.runtime = new Runtime();
  }

  async *streaming(body: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    const model = body.model ?? "acp/kimi";
    const optionalParams = (body as Record<string, unknown>) ?? {};
    const messages = body.messages ?? normalizeIncomingMessages(body as Record<string, unknown>);
    const tools = body.tools;

    const { adapter, modelId } = this.registry.resolve(model, optionalParams);
    const spec = adapter.buildSpec(optionalParams);
    if (modelId) spec.modelId = modelId;
    const promptText = messagesToPrompt(messages, tools) || "User: Hello";

    yield* this.runtime.runStream({
      spec,
      promptText,
      optionalParams,
      messages,
    });
  }

  async completion(body: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const model = body.model ?? "acp/kimi";
    const parts: string[] = [];

    for await (const chunk of this.streaming(body)) {
      const text = chunk.text;
      if (text) parts.push(text);
    }

    const outputText = parts.join("").trim() || "No final assistant text captured from router.";

    return {
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
    };
  }
}
