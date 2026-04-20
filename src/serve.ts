#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { Registry } from "./registry.js";
import { KimiAdapter, DevinAdapter } from "./adapters/index.js";
import { RouterHandler, type ChatCompletionRequest } from "./router_handler.js";
import { Runtime, detectIsolationMode, ensureDockerImage } from "./runtime.js";
import { WorkspaceManager } from "./workspace.js";
import { log } from "./logger.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

// Set up registry
const defaultAgent = process.env.ROUTER_DEFAULT_AGENT ?? "kimi";
const registry = new Registry(defaultAgent);
registry.register(new KimiAdapter());
registry.register(new DevinAdapter());

// Detect isolation mode at startup; build Docker image if needed
let isolationMode = detectIsolationMode();
if (isolationMode === "docker" && !ensureDockerImage()) {
  log.warn("  falling back to sandbox isolation");
  isolationMode = "sandbox";
}

// Set up workspace manager
const workspaces = new WorkspaceManager();
const handler = new RouterHandler(registry, workspaces, isolationMode);

// Discover available models from each agent at startup
async function discoverAllModels(): Promise<void> {
  const runtime = new Runtime(isolationMode);
  const allAdapters = registry.listAdapters();
  log.info(`  discovering models for ${allAdapters.length} adapter(s)...`);
  for (const adapter of allAdapters) {
    try {
      const spec = adapter.buildSpec({});
      log.info(`    ${adapter.agentId}: probing (${spec.bin})...`);
      const models = await runtime.discoverModels(spec);
      if (models.length > 0) {
        registry.markAvailable(adapter.agentId);
        registry.setModels(adapter.agentId, models);
        log.info(`    ${adapter.agentId}: ${models.length} model(s)`);
      } else {
        log.info(`    ${adapter.agentId}: reachable but no models reported`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.info(`    ${adapter.agentId}: not available — ${reason}`);
    }
  }
  registry.discoveryDone = true;
}

// GET /v1/models - list available models
app.get("/v1/models", (_req, res) => {
  const discoveredModels = registry.listAllModels();
  const agentModels = discoveredModels.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 1677610602,
    owned_by: `acp-gateway:${m.agentId}`,
  }));

  // Only show generic acp/{agentId} entries for adapters with no discovered models
  const agentIdsWithModels = new Set(discoveredModels.map((m) => m.agentId));
  const fallbackModels = registry
    .listAdapters()
    .filter((a) => !agentIdsWithModels.has(a.agentId))
    .map((a) => ({
      id: `acp/${a.agentId}`,
      object: "model" as const,
      created: 1677610602,
      owned_by: "acp-gateway",
    }));

  res.json({ data: [...fallbackModels, ...agentModels], object: "list" });
});

// POST /v1/chat/completions - main endpoint
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body as ChatCompletionRequest;
  const conversationId =
    (req.headers["x-conversation-id"] as string) ?? (body.conversation_id as string) ?? undefined;

  try {
    if (body.stream) {
      // SSE streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const model = body.model ?? "acp/kimi";
      const { chunks, context } = handler.streamingWithContext(body, conversationId);

      res.setHeader("X-Conversation-Id", context.conversationId);

      for await (const chunk of chunks) {
        const sseData = {
          id: `chatcmpl-${uuidv4()}`,
          created: Math.floor(Date.now() / 1000),
          model,
          object: "chat.completion.chunk",
          choices: [
            chunk.is_finished
              ? {
                  finish_reason: chunk.finish_reason ?? "stop",
                  index: 0,
                  delta: chunk.tool_calls ? { tool_calls: chunk.tool_calls } : {},
                }
              : { index: 0, delta: { content: chunk.text, role: "assistant" } },
          ],
        };
        res.write(`data: ${JSON.stringify(sseData)}\n\n`);
      }

      // After stream completes, send artifact info as a final SSE event
      const ws = workspaces.getOrCreate(context.conversationId);
      const allFiles = workspaces.listFiles(ws);
      if (allFiles.length > 0) {
        const artifactEvent = {
          conversation_id: context.conversationId,
          artifacts: {
            token: context.token,
            files: allFiles,
            base_url: `/v1/artifacts/${context.token}`,
          },
        };
        res.write(`data: ${JSON.stringify(artifactEvent)}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      // Non-streaming response
      const response = await handler.completion(body, conversationId);
      res.setHeader("X-Conversation-Id", response.conversation_id ?? "");
      res.json(response);
    }
  } catch (err) {
    console.error("[acp-gateway] Error:", err);
    res.status(500).json({
      error: {
        message: String(err instanceof Error ? err.message : err),
        type: "internal_error",
      },
    });
  }
});

// GET /v1/artifacts/:token - list files in workspace
app.get("/v1/artifacts/:token", (req, res) => {
  const ws = workspaces.getByToken(req.params.token);
  if (!ws) {
    res
      .status(404)
      .json({ error: { message: "Workspace not found or expired", type: "not_found" } });
    return;
  }

  const files = workspaces.listFiles(ws);
  res.json({
    conversation_id: ws.conversationId,
    files,
    base_url: `/v1/artifacts/${ws.token}`,
  });
});

// GET /v1/artifacts/:token/* - serve a specific file from workspace
app.get("/v1/artifacts/:token{/*filepath}", (req, res) => {
  const ws = workspaces.getByToken(req.params.token);
  if (!ws) {
    res
      .status(404)
      .json({ error: { message: "Workspace not found or expired", type: "not_found" } });
    return;
  }

  const filePath = (req.params as unknown as Record<string, string | string[]>).filepath;
  const resolvedPath = Array.isArray(filePath) ? filePath.join("/") : (filePath ?? "");
  if (!resolvedPath) {
    res.status(400).json({ error: { message: "File path required", type: "bad_request" } });
    return;
  }

  const resolved = workspaces.resolveFilePath(ws, resolvedPath);
  if (!resolved) {
    res.status(404).json({ error: { message: "File not found", type: "not_found" } });
    return;
  }

  const mime = guessMime(resolved);
  res.setHeader("Content-Type", mime);
  try {
    const stat = statSync(resolved);
    res.setHeader("Content-Length", stat.size);
  } catch {
    // ignore
  }
  createReadStream(resolved).pipe(res);
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Periodic workspace garbage collection (every 10 minutes)
setInterval(() => {
  const removed = workspaces.gc();
  if (removed > 0) {
    log.debug(`GC: removed ${removed} expired workspace(s)`);
  }
}, 600_000);

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".ts": "text/plain",
    ".py": "text/plain",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}

const port = parseInt(process.env.PORT ?? "4001", 10);
const host = process.env.HOST ?? "0.0.0.0";

app.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  log.info(`acp-gateway listening on http://${displayHost}:${port}`);
  log.info(`  OpenAI-compatible API: http://${displayHost}:${port}/v1`);
  log.info(`  isolation: ${isolationMode}`);

  // Discover models in the background after server starts
  discoverAllModels().then(() => {
    const discovered = registry.listAllModels();
    if (discovered.length > 0) {
      // Group by agent for a compact summary
      const byAgent = new Map<string, number>();
      for (const m of discovered) {
        byAgent.set(m.agentId, (byAgent.get(m.agentId) ?? 0) + 1);
      }
      const summary = [...byAgent.entries()].map(([id, n]) => `${id} (${n})`).join(", ");
      log.info(`  agents: ${summary}`);
    }
  });
});
