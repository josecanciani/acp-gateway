import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contentBlocksToText,
  messagesToPrompt,
  normalizeIncomingMessages,
  pickPermissionOption,
  extractExistingPathsFromText,
} from "../src/utils.js";

describe("contentBlocksToText", () => {
  it("returns empty string for null/undefined", () => {
    assert.equal(contentBlocksToText(null), "");
    assert.equal(contentBlocksToText(undefined), "");
  });

  it("returns trimmed string for string input", () => {
    assert.equal(contentBlocksToText("  hello  "), "hello");
  });

  it("extracts text from content block object", () => {
    assert.equal(contentBlocksToText({ type: "text", text: "hello" }), "hello");
  });

  it("extracts text from array of content blocks", () => {
    const result = contentBlocksToText([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
    assert.equal(result, "hello\nworld");
  });

  it("handles nested content", () => {
    assert.equal(contentBlocksToText({ content: { type: "text", text: "nested" } }), "nested");
  });

  it("handles mixed array content", () => {
    const result = contentBlocksToText(["plain string", { type: "text", text: "block" }]);
    assert.equal(result, "plain string\nblock");
  });
});

describe("messagesToPrompt", () => {
  it("formats user message", () => {
    const result = messagesToPrompt([{ role: "user", content: "hello" }]);
    assert.ok(result.includes("User: hello"));
  });

  it("formats system + user messages", () => {
    const result = messagesToPrompt([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hello" },
    ]);
    assert.ok(result.includes("System instructions:"));
    assert.ok(result.includes("be helpful"));
    assert.ok(result.includes("User: hello"));
  });

  it("formats assistant messages", () => {
    const result = messagesToPrompt([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
    ]);
    assert.ok(result.includes("Assistant: hello back"));
  });

  it("formats tool messages", () => {
    const result = messagesToPrompt([{ role: "tool", content: "result", name: "search" }]);
    assert.ok(result.includes("Tool (search): result"));
  });

  it("includes tool hints when tools provided", () => {
    const result = messagesToPrompt(
      [{ role: "user", content: "do it" }],
      [{ type: "function", function: { name: "read_file" } }],
    );
    assert.ok(result.includes("Client tool hints:"));
    assert.ok(result.includes("read_file"));
  });

  it("appends important instructions", () => {
    const result = messagesToPrompt([{ role: "user", content: "hi" }]);
    assert.ok(result.includes("Important:"));
    assert.ok(result.includes("non-interactive commands"));
  });
});

describe("normalizeIncomingMessages", () => {
  it("returns messages array when present", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = normalizeIncomingMessages({ messages });
    assert.deepEqual(result, messages);
  });

  it("falls back to input field", () => {
    const result = normalizeIncomingMessages({ input: "hello" });
    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
    assert.equal(result[0].content, "hello");
  });

  it("includes instructions as system message", () => {
    const result = normalizeIncomingMessages({
      input: "hello",
      instructions: "be brief",
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "system");
    assert.equal(result[0].content, "be brief");
  });
});

describe("pickPermissionOption", () => {
  it("picks allow_always first", () => {
    const result = pickPermissionOption([
      { optionId: "1", kind: "allow_once" },
      { optionId: "2", kind: "allow_always" },
    ]);
    assert.equal(result, "2");
  });

  it("picks allow_once when no allow_always", () => {
    const result = pickPermissionOption([
      { optionId: "1", kind: "reject_once" },
      { optionId: "2", kind: "allow_once" },
    ]);
    assert.equal(result, "2");
  });

  it("returns null when no allow options", () => {
    const result = pickPermissionOption([
      { optionId: "1", kind: "reject_once" },
      { optionId: "2", kind: "reject_always" },
    ]);
    assert.equal(result, null);
  });

  it("handles empty array", () => {
    assert.equal(pickPermissionOption([]), null);
  });
});

describe("extractExistingPathsFromText", () => {
  it("finds existing paths", () => {
    const result = extractExistingPathsFromText("look at /tmp and /dev/null");
    assert.ok(result.length > 0);
  });

  it("returns empty for non-existent paths", () => {
    const result = extractExistingPathsFromText("look at /nonexistent/path/that/does/not/exist");
    assert.equal(result.length, 0);
  });
});
