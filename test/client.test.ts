import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentClient } from "../src/client.js";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

describe("AgentClient permission filtering", () => {
  /**
   * Helper to build a minimal RequestPermissionRequest with the given toolCall shape.
   * Options include an "allow_always" choice to verify the happy path.
   */
  function makeRequest(toolCall: Record<string, unknown>): RequestPermissionRequest {
    return {
      toolCall,
      options: [{ optionId: "allow_always", kind: "allow_always" }],
    } as RequestPermissionRequest;
  }

  it("allows requests within workspace via locations[].path", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        locations: [{ path: "/workspace/project/src/index.ts" }],
      }),
    );
    assert.equal(result.outcome.outcome, "selected");
  });

  it("denies requests outside workspace via locations[].path", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        locations: [{ path: "/etc/passwd" }],
      }),
    );
    assert.equal(result.outcome.outcome, "cancelled");
  });

  it("allows requests when path equals workspace exactly", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        locations: [{ path: "/workspace/project" }],
      }),
    );
    assert.equal(result.outcome.outcome, "selected");
  });

  it("denies when any path in locations is outside workspace", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        locations: [{ path: "/workspace/project/src/foo.ts" }, { path: "/home/user/.ssh/id_rsa" }],
      }),
    );
    assert.equal(result.outcome.outcome, "cancelled");
  });

  it("allows requests with no extractable paths (non-file operations)", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        toolName: "web_search",
        rawInput: { query: "hello world" },
      }),
    );
    assert.equal(result.outcome.outcome, "selected");
  });

  it("denies requests outside workspace via rawInput.file_path", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        rawInput: { file_path: "/tmp/secret.txt" },
      }),
    );
    assert.equal(result.outcome.outcome, "cancelled");
  });

  it("denies requests outside workspace via rawInput.directory", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        rawInput: { directory: "/home/user/other-project" },
      }),
    );
    assert.equal(result.outcome.outcome, "cancelled");
  });

  it("allows requests via rawInput.path inside workspace", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        rawInput: { path: "/workspace/project/README.md" },
      }),
    );
    assert.equal(result.outcome.outcome, "selected");
  });

  it("skips workspace check when workspaceDir is not set", async () => {
    const client = new AgentClient("auto_allow");
    const result = await client.requestPermission(
      makeRequest({
        locations: [{ path: "/anywhere/at/all" }],
      }),
    );
    assert.equal(result.outcome.outcome, "selected");
  });

  it("denies all permissions in cancel mode regardless of path", async () => {
    const client = new AgentClient("cancel", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        locations: [{ path: "/workspace/project/ok.ts" }],
      }),
    );
    assert.equal(result.outcome.outcome, "cancelled");
  });

  it("prevents path traversal via .. in locations", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        locations: [{ path: "/workspace/project/../../../etc/passwd" }],
      }),
    );
    assert.equal(result.outcome.outcome, "cancelled");
  });

  it("prevents path traversal via .. in rawInput", async () => {
    const client = new AgentClient("auto_allow", "/workspace/project");
    const result = await client.requestPermission(
      makeRequest({
        rawInput: { cwd: "/workspace/project/../../etc" },
      }),
    );
    assert.equal(result.outcome.outcome, "cancelled");
  });
});

describe("AgentClient event queue", () => {
  it("pushes and pulls events", async () => {
    const client = new AgentClient();
    // Simulate a session update
    await client.sessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    } as never);

    const event = await client.pullEvent(50);
    assert.ok(event);
    assert.equal(event.text, "hello");
  });

  it("returns null when queue is empty", async () => {
    const client = new AgentClient();
    const event = await client.pullEvent(10);
    assert.equal(event, null);
  });

  it("suppresses events when suppressStream is true", async () => {
    const client = new AgentClient();
    client.suppressStream = true;
    await client.sessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hidden" },
      },
    } as never);

    const event = await client.pullEvent(10);
    assert.equal(event, null);
  });

  it("tracks file locations from tool_call events", async () => {
    const client = new AgentClient();
    await client.sessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        kind: "file_edit",
        toolCallId: "tc-1",
        locations: [{ path: "/workspace/foo.ts" }],
      },
    } as never);

    assert.equal(client.trackedFiles.length, 1);
    assert.equal(client.trackedFiles[0].path, "/workspace/foo.ts");
    assert.equal(client.trackedFiles[0].toolCallId, "tc-1");
  });
});
