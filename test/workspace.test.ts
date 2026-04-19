import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WorkspaceManager } from "../src/workspace.js";

const TEST_BASE = path.join(process.cwd(), "dist-test", ".test-workspaces");

describe("WorkspaceManager", () => {
  let manager: WorkspaceManager;

  beforeEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
    manager = new WorkspaceManager(TEST_BASE, 60_000);
  });

  afterEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it("creates a workspace with generated ID", () => {
    const ws = manager.getOrCreate();
    assert.ok(ws.conversationId);
    assert.ok(ws.token);
    assert.ok(ws.dir.startsWith(TEST_BASE));
    assert.ok(existsSync(ws.dir));
  });

  it("creates a workspace with explicit ID", () => {
    const ws = manager.getOrCreate("my-convo-123");
    assert.equal(ws.conversationId, "my-convo-123");
    assert.ok(existsSync(ws.dir));
  });

  it("returns existing workspace for same conversation ID", () => {
    const ws1 = manager.getOrCreate("test-id");
    const ws2 = manager.getOrCreate("test-id");
    assert.equal(ws1.token, ws2.token);
    assert.equal(ws1.dir, ws2.dir);
  });

  it("resolves workspace by token", () => {
    const ws = manager.getOrCreate("lookup-test");
    const found = manager.getByToken(ws.token);
    assert.ok(found);
    assert.equal(found!.conversationId, "lookup-test");
  });

  it("returns null for unknown token", () => {
    assert.equal(manager.getByToken("nonexistent"), null);
  });

  it("materializes image_url data URIs into workspace", () => {
    const ws = manager.getOrCreate("upload-test");
    const pngData = Buffer.from("fake-png-data").toString("base64");
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "analyze this" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${pngData}` } },
        ],
      },
    ];

    const written = manager.materializeFiles(ws, messages);
    assert.equal(written.length, 1);
    assert.ok(written[0].endsWith(".png"));

    const absPath = path.join(ws.dir, written[0]);
    assert.ok(existsSync(absPath));
    assert.equal(readFileSync(absPath).toString(), "fake-png-data");
  });

  it("materializes file attachments into workspace", () => {
    const ws = manager.getOrCreate("file-attach-test");
    const fileData = Buffer.from("hello world").toString("base64");
    const messages = [
      {
        role: "user",
        content: [
          { type: "file", file: { data: fileData, name: "readme.md", mime_type: "text/markdown" } },
        ],
      },
    ];

    const written = manager.materializeFiles(ws, messages);
    assert.equal(written.length, 1);
    assert.equal(written[0], "uploads/readme.md");

    const absPath = path.join(ws.dir, written[0]);
    assert.ok(existsSync(absPath));
    assert.equal(readFileSync(absPath, "utf8"), "hello world");
  });

  it("listFiles returns all files in workspace", () => {
    const ws = manager.getOrCreate("list-test");
    mkdirSync(path.join(ws.dir, "sub"), { recursive: true });
    writeFileSync(path.join(ws.dir, "a.txt"), "a");
    writeFileSync(path.join(ws.dir, "sub", "b.txt"), "b");

    const files = manager.listFiles(ws);
    assert.ok(files.includes("a.txt"));
    assert.ok(files.includes(path.join("sub", "b.txt")));
  });

  it("resolveFilePath prevents directory traversal", () => {
    const ws = manager.getOrCreate("traversal-test");
    writeFileSync(path.join(ws.dir, "safe.txt"), "ok");

    assert.ok(manager.resolveFilePath(ws, "safe.txt"));
    assert.equal(manager.resolveFilePath(ws, "../../../etc/passwd"), null);
  });

  it("gc removes expired workspaces", () => {
    const shortTtl = new WorkspaceManager(TEST_BASE, 1); // 1ms TTL
    const ws = shortTtl.getOrCreate("expire-me");
    assert.ok(existsSync(ws.dir));

    // Force expiry by waiting
    ws.lastActivity = Date.now() - 100;
    const removed = shortTtl.gc();
    assert.equal(removed, 1);
    assert.equal(shortTtl.getByToken(ws.token), null);
  });
});
