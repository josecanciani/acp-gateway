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
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { Registry } from "../../src/registry.js";
import { StaticAdapter } from "../../src/adapters/static.js";
import { RouterHandler, type ChatCompletionRequest } from "../../src/router_handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, "..", "mock-agent.js");

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

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  const registry = new Registry("mock");
  registry.register(new MockAdapter());
  handler = new RouterHandler(registry);

  app.get("/v1/models", (_req, res) => {
    res.json({
      data: [{ id: "acp-mock", object: "model", created: 1677610602, owned_by: "test" }],
      object: "list",
    });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const body = req.body as ChatCompletionRequest;
    try {
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const model = body.model ?? "acp/mock";
        for await (const chunk of handler.streaming(body)) {
          const sseData = {
            id: `chatcmpl-${uuidv4()}`,
            created: Math.floor(Date.now() / 1000),
            model,
            object: "chat.completion.chunk",
            choices: [
              chunk.is_finished
                ? { finish_reason: "stop", index: 0, delta: {} }
                : { index: 0, delta: { content: chunk.text, role: "assistant" } },
            ],
          };
          res.write(`data: ${JSON.stringify(sseData)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const response = await handler.completion(body);
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

  it("GET /v1/models lists available models", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    assert.equal(res.status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, "acp-mock");
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
});
