/**
 * Integration tests for the ACP Router HTTP endpoints.
 *
 * Starts the Express server with a mock ACP agent adapter, then hits the
 * OpenAI-compatible endpoints with real HTTP requests.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, createReadStream } from "node:fs";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { Registry } from "../../src/registry.js";
import { StaticAdapter } from "../../src/adapters/static.js";
import { RouterHandler, type ChatCompletionRequest } from "../../src/router_handler.js";
import { Runtime } from "../../src/runtime.js";
import { WorkspaceManager } from "../../src/workspace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, "..", "mock-agent.js");
const TEST_WORKSPACE_DIR = join(__dirname, "..", ".test-integration-workspaces");

/** Adapter that spawns the compiled mock agent instead of a real CLI */
class MockAdapter extends StaticAdapter {
  constructor() {
    super({
      agentId: "mock",
      defaultBin: "node",
      defaultArgs: [MOCK_AGENT_PATH],
      defaultModeId: undefined,
      defaultBootstrapCommands: [],
      aliases: ["mock-agent"],
      envVarPrefix: "MOCK",
    });
  }
}

let server: Server;
let baseUrl: string;
let handler: RouterHandler;
let registry: Registry;
let workspaces: WorkspaceManager;

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  registry = new Registry("mock");
  const mockAdapter = new MockAdapter();
  registry.register(mockAdapter);
  workspaces = new WorkspaceManager(TEST_WORKSPACE_DIR, 60_000);
  handler = new RouterHandler(registry, workspaces);

  // Discover models from mock agent (like serve.ts does)
  const runtime = new Runtime();
  const spec = mockAdapter.buildSpec({});
  const models = await runtime.discoverModels(spec);
  if (models.length > 0) {
    registry.setModels(mockAdapter.agentId, models);
  }

  app.get("/v1/models", (_req, res) => {
    const discoveredModels = registry.listAllModels();
    const adapterModels = registry.listAdapters().map((a) => ({
      id: `acp/${a.agentId}`,
      object: "model" as const,
      created: 1677610602,
      owned_by: "acp-gateway",
    }));
    const agentModels = discoveredModels.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 1677610602,
      owned_by: `acp-gateway:${m.agentId}`,
    }));

    res.json({ data: [...adapterModels, ...agentModels], object: "list" });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const body = req.body as ChatCompletionRequest;
    const conversationId =
      (req.headers["x-conversation-id"] as string) ?? (body.conversation_id as string) ?? undefined;

    try {
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const model = body.model ?? "acp/mock";
        const { chunks, context } = handler.streamingWithContext(body, conversationId);
        res.setHeader("X-Conversation-Id", context.conversationId);

        const WRITE_BUFFER_LIMIT = 1_048_576;
        let clientGone = false;
        const abort = () => {
          if (!clientGone) {
            clientGone = true;
            context.abort();
          }
        };
        res.on("close", abort);
        res.on("error", abort);

        try {
          for await (const chunk of chunks) {
            if (clientGone) break;
            const sseData = {
              id: `chatcmpl-${uuidv4()}`,
              created: Math.floor(Date.now() / 1000),
              model,
              object: "chat.completion.chunk",
              choices: [
                chunk.is_finished
                  ? {
                      finish_reason: "stop",
                      index: 0,
                      delta: {},
                    }
                  : {
                      index: 0,
                      delta: {
                        content: chunk.text,
                        role: "assistant",
                      },
                    },
              ],
            };
            res.write(`data: ${JSON.stringify(sseData)}\n\n`);
            if (res.writableLength > WRITE_BUFFER_LIMIT) {
              abort();
              break;
            }
          }
        } catch (err) {
          if (!clientGone) throw err;
        }

        if (!clientGone) {
          res.write("data: [DONE]\n\n");
          res.end();
          clientGone = true;
        }
      } else {
        const response = await handler.completion(body, conversationId);
        res.setHeader("X-Conversation-Id", response.conversation_id ?? "");
        res.json(response);
      }
    } catch (err) {
      res.status(500).json({
        error: {
          message: String(err instanceof Error ? err.message : err),
          type: "internal_error",
        },
      });
    }
  });

  // Artifact endpoints
  app.get("/v1/artifacts/:token", (req, res) => {
    const ws = workspaces.getByToken(req.params.token);
    if (!ws) {
      res.status(404).json({
        error: {
          message: "Workspace not found or expired",
          type: "not_found",
        },
      });
      return;
    }
    const files = workspaces.listFiles(ws);
    res.json({
      conversation_id: ws.conversationId,
      files,
      base_url: `/v1/artifacts/${ws.token}`,
    });
  });

  app.get("/v1/artifacts/:token{/*filepath}", (req, res) => {
    const ws = workspaces.getByToken(req.params.token);
    if (!ws) {
      res.status(404).json({
        error: {
          message: "Workspace not found or expired",
          type: "not_found",
        },
      });
      return;
    }
    const filePath = (req.params as unknown as Record<string, string | string[]>).filepath;
    const resolvedPath = Array.isArray(filePath) ? filePath.join("/") : (filePath ?? "");
    if (!resolvedPath) {
      res.status(400).json({
        error: { message: "File path required", type: "bad_request" },
      });
      return;
    }
    const resolved = workspaces.resolveFilePath(ws, resolvedPath);
    if (!resolved) {
      res.status(404).json({
        error: { message: "File not found", type: "not_found" },
      });
      return;
    }
    createReadStream(resolved).pipe(res);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}

function stopServer(): void {
  server?.close();
  rmSync(TEST_WORKSPACE_DIR, { recursive: true, force: true });
}

describe("ACP Router HTTP endpoints", () => {
  before(async () => {
    await startServer();
  });

  after(() => {
    stopServer();
  });

  it("GET /health returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as { status: string };
    assert.equal(res.status, 200);
    assert.equal(body.status, "ok");
  });

  it("GET /v1/models lists adapter and discovered models", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    const body = (await res.json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };
    assert.equal(res.status, 200);

    // Should have the base adapter model plus discovered models
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes("acp/mock"), `expected acp/mock in ${JSON.stringify(ids)}`);
    assert.ok(
      ids.includes("mock/mock-model-a"),
      `expected mock/mock-model-a in ${JSON.stringify(ids)}`,
    );
    assert.ok(
      ids.includes("mock/mock-model-b"),
      `expected mock/mock-model-b in ${JSON.stringify(ids)}`,
    );
  });

  it("POST /v1/chat/completions returns mock-response", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(res.status, 200);
    assert.equal(body.choices[0].message.content, "mock-response");
  });

  it("routes mock/{modelId} to mock adapter with model selection", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock/mock-model-b",
        messages: [{ role: "user", content: "echo: model-test" }],
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(res.status, 200);
    assert.ok(
      body.choices[0].message.content.startsWith("model-test"),
      `expected content to start with "model-test", got: ${body.choices[0].message.content.slice(0, 60)}`,
    );
  });

  it("echoes back text after echo: prefix", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "echo: hello world" }],
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.ok(
      body.choices[0].message.content.startsWith("hello world"),
      `expected content to start with "hello world", got: ${body.choices[0].message.content.slice(0, 60)}`,
    );
  });

  it("returns multiple chunks concatenated", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "multi" }],
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.choices[0].message.content, "chunk-1chunk-2");
  });

  it("handles permission requests with auto_allow", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "permission" }],
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.choices[0].message.content, "permission-granted");
  });

  it("streams SSE chunks correctly", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        stream: true,
        messages: [{ role: "user", content: "echo: streamed" }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));

    // Should have at least one content chunk and [DONE]
    assert.ok(lines.length >= 2, `expected >= 2 SSE lines, got ${lines.length}`);
    assert.ok(lines[lines.length - 1].includes("[DONE]"));

    // First chunk should contain our text
    const firstChunk = JSON.parse(lines[0].replace("data: ", "")) as {
      choices: Array<{ delta: { content?: string } }>;
    };
    assert.ok(
      firstChunk.choices[0].delta.content?.startsWith("streamed"),
      `expected first SSE chunk to start with "streamed", got: ${firstChunk.choices[0].delta.content?.slice(0, 60)}`,
    );
  });

  it("response has correct OpenAI-compatible shape", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    assert.ok(typeof body.id === "string");
    assert.ok((body.id as string).startsWith("chatcmpl-"));
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "acp-mock");
    assert.ok(typeof body.created === "number");
    assert.ok(Array.isArray(body.choices));
    assert.ok(typeof body.usage === "object");
  });

  it("returns conversation_id in response", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(typeof body.conversation_id === "string");
    assert.ok((body.conversation_id as string).length > 0);
    // Also check response header
    assert.ok(res.headers.get("x-conversation-id"));
  });

  it("reuses workspace when conversation_id is sent back", async () => {
    // First request - get conversation ID
    const res1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "echo: first" }],
      }),
    });
    const body1 = (await res1.json()) as Record<string, unknown>;
    const convId = body1.conversation_id as string;

    // Second request - reuse conversation
    const res2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Conversation-Id": convId,
      },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "echo: second" }],
      }),
    });
    const body2 = (await res2.json()) as Record<string, unknown>;
    assert.equal(body2.conversation_id, convId);
  });

  it("agent creates files visible via artifact endpoint", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "file: hello.txt" }],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    assert.ok(body.artifacts, "expected artifacts in response");
    const artifacts = body.artifacts as {
      token: string;
      files: string[];
      base_url: string;
    };
    assert.ok(artifacts.token);
    assert.ok(
      artifacts.files.includes("hello.txt"),
      `expected hello.txt in ${JSON.stringify(artifacts.files)}`,
    );

    // Fetch the file via artifact endpoint
    const fileRes = await fetch(`${baseUrl}${artifacts.base_url}/hello.txt`);
    assert.equal(fileRes.status, 200);
    const content = await fileRes.text();
    assert.equal(content, "content of hello.txt");
  });

  it("artifact endpoint returns 404 for invalid token", async () => {
    const res = await fetch(`${baseUrl}/v1/artifacts/nonexistent`);
    assert.equal(res.status, 404);
  });

  it("artifact endpoint prevents directory traversal", async () => {
    // First create a workspace with a file
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "file: safe.txt" }],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const artifacts = body.artifacts as { token: string; base_url: string };

    // Try to escape workspace directory
    const traversalRes = await fetch(`${baseUrl}${artifacts.base_url}/../../../etc/passwd`);
    assert.equal(traversalRes.status, 404);
  });

  it("prepends gateway system prompt to agent prompt", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "prompt: dump" }],
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(res.status, 200);
    const content = body.choices[0].message.content;
    // The default system prompt should appear in the prompt text
    assert.ok(
      content.includes("You are a helpful AI assistant"),
      `expected system prompt in prompt text, got: ${content.slice(0, 200)}`,
    );
    assert.ok(
      content.includes("Do NOT use tools"),
      `expected tool restriction in prompt text, got: ${content.slice(0, 200)}`,
    );
    // The user message should also be present
    assert.ok(
      content.includes("prompt: dump"),
      `expected user message in prompt text, got: ${content.slice(0, 200)}`,
    );
  });

  it("returns tool_calls when request includes tools and agent calls MCP tool", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [
          {
            role: "user",
            content: 'mcp-tool: read_file {"path": "src/app.ts"}',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          },
        ],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);

    const choices = body.choices as Array<{
      finish_reason: string;
      message: {
        tool_calls?: Array<{
          function: { name: string; arguments: string };
        }>;
      };
    }>;
    assert.equal(choices[0].finish_reason, "tool_calls");
    assert.ok(choices[0].message.tool_calls, "expected tool_calls in response");
    assert.equal(choices[0].message.tool_calls!.length, 1);
    assert.equal(choices[0].message.tool_calls![0].function.name, "read_file");

    const args = JSON.parse(choices[0].message.tool_calls![0].function.arguments);
    assert.equal(args.path, "src/app.ts");
  });

  it("uses tool bridge system prompt when tools are present", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "prompt: dump-with-tools" }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "Search codebase",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(res.status, 200);
    const content = body.choices[0].message.content;
    // Should have tool bridge prompt, not the default one
    assert.ok(
      content.includes("MCP tools") || content.includes("client-tools"),
      `expected tool bridge system prompt, got: ${content.slice(0, 200)}`,
    );
    assert.ok(
      !content.includes("Do NOT use tools such as shell commands"),
      "should not have default system prompt when tools are present",
    );
  });

  it("returns finish_reason stop when tools present but agent doesn't call them", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        messages: [{ role: "user", content: "echo: just-text" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);

    const choices = body.choices as Array<{
      finish_reason: string;
      message: { content: string; tool_calls?: unknown[] };
    }>;
    assert.equal(choices[0].finish_reason, "stop");
    assert.ok(
      !choices[0].message.tool_calls,
      "should not have tool_calls when agent doesn't call tools",
    );
  });

  it("handles client disconnect without hanging the server", async () => {
    const controller = new AbortController();

    // Start a streaming request with the slow mock (2 s delay)
    const fetchPromise = fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-mock",
        stream: true,
        messages: [{ role: "user", content: "slow" }],
      }),
      signal: controller.signal,
    });

    // Abort the request while the agent is still processing
    await new Promise((r) => setTimeout(r, 500));
    controller.abort();
    await fetchPromise.catch(() => {});

    // The server should still be responsive after the client disconnect
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
  });
});
