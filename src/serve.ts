#!/usr/bin/env node
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { Registry } from "./registry.js";
import { KimiAdapter, DevinAdapter } from "./adapters/index.js";
import { RouterHandler, type ChatCompletionRequest } from "./router_handler.js";
import { Runtime } from "./runtime.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Set up registry
const defaultAgent = process.env.ROUTER_DEFAULT_AGENT ?? "kimi";
const registry = new Registry(defaultAgent);
registry.register(new KimiAdapter());
registry.register(new DevinAdapter());

const handler = new RouterHandler(registry);

// Discover available models from each agent at startup
async function discoverAllModels(): Promise<void> {
  const runtime = new Runtime();
  for (const adapter of registry.listAdapters()) {
    try {
      const spec = adapter.buildSpec({});
      const models = await runtime.discoverModels(spec);
      if (models.length > 0) {
        registry.setModels(adapter.agentId, models);
        console.log(
          `  Discovered ${models.length} model(s) for ${adapter.agentId}: ${models.map((m) => m.modelId).join(", ")}`,
        );
      }
    } catch {
      // Agent not available — skip silently
    }
  }
}

// GET /v1/models - list available models
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
  `);

  // Discover models in the background after server starts
  discoverAllModels().then(() => {
    const discovered = registry.listAllModels();
    if (discovered.length > 0) {
      console.log(`   Models: ${discovered.map((m) => m.id).join(", ")}`);
    } else {
      const adapters = registry.listAdapters();
      console.log(
        `   Models: ${adapters.map((a) => `acp/${a.agentId}`).join(", ")} (no agent-specific models discovered)`,
      );
    }
  });
});
