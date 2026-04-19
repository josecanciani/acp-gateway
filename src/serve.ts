#!/usr/bin/env node
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { Registry } from "./registry.js";
import { KimiAdapter, DevinAdapter } from "./adapters/index.js";
import { RouterHandler, type ChatCompletionRequest } from "./router_handler.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Set up registry
const defaultAgent = process.env.ROUTER_DEFAULT_AGENT ?? "kimi";
const registry = new Registry(defaultAgent);
registry.register(new KimiAdapter());
registry.register(new DevinAdapter());

const handler = new RouterHandler(registry);

// GET /v1/models - list available models
app.get("/v1/models", (_req, res) => {
  const models = [
    { id: "acp-kimi", object: "model", created: 1677610602, owned_by: "acp-router" },
    { id: "acp-devin", object: "model", created: 1677610602, owned_by: "acp-router" },
  ];
  res.json({ data: models, object: "list" });
});

// POST /v1/chat/completions - main endpoint
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body as ChatCompletionRequest;

  try {
    if (body.stream) {
      // SSE streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const model = body.model ?? "acp/kimi";

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
      // Non-streaming response
      const response = await handler.completion(body);
      res.json(response);
    }
  } catch (err) {
    console.error("[acp-router] Error:", err);
    res.status(500).json({
      error: {
        message: String(err instanceof Error ? err.message : err),
        type: "internal_error",
      },
    });
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const port = parseInt(process.env.PORT ?? "4001", 10);
const host = process.env.HOST ?? "0.0.0.0";

app.listen(port, host, () => {
  console.log(`
   ╔══════════════════════════════════════╗
   ║         ACP Router (Node.js)         ║
   ║                                      ║
   ║   OpenAI-compatible → ACP agents     ║
   ╚══════════════════════════════════════╝

   Listening on http://${host}:${port}
   Models: acp-kimi, acp-devin
  `);
});
