# Tool Bridge: Client-Side Tool Execution via MCP

## Problem

When OpenAI-compatible clients (e.g. VS Code Copilot) send requests with a `tools` array, they expect the endpoint to behave like a standard OpenAI API:

1. The model inspects the conversation and decides whether it needs to call tools.
2. If yes, it returns `finish_reason: "tool_calls"` with structured `tool_calls` in the response.
3. The **client** executes the tools locally (reads files, searches code, calls MCP servers, etc.).
4. The client sends a follow-up request with the tool results as `tool` role messages.
5. The loop repeats until the model responds with `finish_reason: "stop"`.

The ACP gateway currently flattens `tools` into text hints in the prompt and routes everything through an ACP agent. The agent uses its **own** internal tools (shell, file ops, browser), which the client doesn't control. The client's tools are never invoked.

## Solution: MCP Tool Bridge

The gateway acts as a **translation layer** between the OpenAI tool-calling protocol and the ACP agent's MCP tool interface.

### Architecture

```
VS Code / Client                  Gateway                           ACP Agent (Devin)
     |                              |                                     |
     |-- POST /chat/completions --->|                                     |
     |   { tools: [A, B, C],       |                                     |
     |     messages: [...] }        |                                     |
     |                              |  1. Extract tools from request      |
     |                              |  2. Start stdio MCP server          |
     |                              |     exposing tools A, B, C          |
     |                              |  3. Pass MCP server to agent        |
     |                              |     via newSession(mcpServers)      |
     |                              |  4. System prompt: "use only        |
     |                              |     MCP tools, no internal tools"   |
     |                              |                                     |
     |                              |-- ACP prompt --------------------->|
     |                              |                                     |
     |                              |   Agent decides to call tool A      |
     |                              |                                     |
     |                              |<-- MCP tools/call: A(args) --------|
     |                              |   (bridge does NOT respond)         |
     |                              |                                     |
     |                              |   Collection window (500ms)...      |
     |                              |                                     |
     |                              |<-- MCP tools/call: B(args) --------|
     |                              |   (bridge does NOT respond)         |
     |                              |                                     |
     |                              |   Window expires, no more calls     |
     |                              |   Kill agent                        |
     |                              |                                     |
     |<-- 200 OK -------------------|                                     |
     |   { finish_reason: "tool_calls",                                   |
     |     tool_calls: [A(args), B(args)],                                |
     |     content: "..." }         |                                     |
     |                              |                                     |
     |   Client executes A and B    |                                     |
     |                              |                                     |
     |-- POST /chat/completions --->|                                     |
     |   { tools: [A, B, C],       |                                     |
     |     messages: [              |                                     |
     |       ...,                   |                                     |
     |       {assistant, tool_calls},                                     |
     |       {tool, result of A},   |                                     |
     |       {tool, result of B},   |                                     |
     |     ] }                      |                                     |
     |                              |  Start new agent session            |
     |                              |  (tool results in prompt text)      |
     |                              |                                     |
     |                              |-- ACP prompt --------------------->|
     |                              |                                     |
     |                              |   Agent responds (no tool calls)    |
     |                              |                                     |
     |<-- 200 OK -------------------|                                     |
     |   { finish_reason: "stop",   |                                     |
     |     content: "Final answer"} |                                     |
```

### Key Design Decisions

#### 1. Stdio MCP Server (not HTTP/SSE)

The ACP spec requires all agents to support `McpServerStdio`. The gateway spawns the MCP bridge as a child process and passes it to the agent via `newSession({ mcpServers })`. This avoids needing to allocate ports or manage HTTP endpoints per request.

The bridge server process is spawned by the gateway and communicates with the agent over stdio pipes. It receives `tools/call` JSON-RPC requests from the agent and buffers them.

**Implementation**: The MCP bridge is a small Node.js script that the gateway writes to a temp file (or embeds inline). It:
- Reads tool definitions from argv or stdin at startup
- Implements the MCP protocol (initialize, tools/list, tools/call)
- On `tools/call`: writes the call to stdout (for the gateway to read) and **blocks** (never responds)

Actually, since the bridge runs as a subprocess that the **agent** spawns (not the gateway), the gateway can't directly observe MCP calls. Instead:

**Revised approach**: The gateway uses an **HTTP-based MCP server** that it hosts on a random port. The agent connects to this URL. When the agent calls a tool, the HTTP request arrives at the gateway's MCP endpoint, where it can be intercepted.

Wait — this won't work in Docker mode because the container can't reach `localhost` on the host.

**Final approach**: Use `McpServerStdio` with a **wrapper script** that the gateway writes to the workspace directory. The wrapper:
1. Speaks MCP protocol over stdio (agent ↔ wrapper)
2. Writes intercepted `tools/call` requests to a **named pipe** or **temp file** that the gateway monitors
3. Blocks until the gateway writes a response (for normal MCP flow) or the process is killed (for tool bridge flow)

This is overly complex. Let's simplify.

#### Simplified Approach: Event-Based Detection

Instead of a separate MCP server process, we leverage the fact that **ACP agents report tool calls via `sessionUpdate` notifications**. When the agent calls an MCP tool, it sends a `tool_call` event to the ACP client with the tool name and arguments.

The gateway already receives these events in `AgentClient.sessionUpdate()`. We can:

1. Detect that a `tool_call` event matches one of the client's OpenAI tools
2. Buffer the tool call
3. After a collection window, kill the agent and return `tool_calls` to the client

**Problem**: The `sessionUpdate` `tool_call` event contains `title`, `kind`, `status`, `locations`, `rawInput` — but does it contain the **tool name** and **arguments** in a format we can map back to OpenAI tool calls?

Looking at the ACP schema, `tool_call` updates have:
- `toolCallId`: unique ID
- `title`: human-readable title (may contain tool name)
- `kind`: "execute", "read", "write", etc.
- `rawInput`: the raw arguments passed to the tool
- `rawOutput`: the result (after completion)

The `rawInput` should contain the MCP tool call arguments. But we need the **tool name** to map it back to the OpenAI tool. The `title` field likely contains it but isn't structured.

**Better approach**: We need the actual MCP `tools/call` request, which has `{ name: "tool_name", arguments: {...} }`. The `sessionUpdate` is a notification *about* the tool call, not the call itself.

#### Final Architecture: Inline MCP Bridge via Stdio

The gateway implements an MCP server as a **Node.js child process** that it spawns itself. The gateway passes this process's command to the agent via `McpServerStdio`:

```typescript
mcpServers: [{
  name: "client-tools",
  command: "node",
  args: [bridgeScriptPath],
  env: [{ name: "TOOLS_JSON", value: JSON.stringify(tools) }]
}]
```

The bridge script:
1. Implements MCP protocol over stdio
2. On `initialize`: responds with capabilities
3. On `tools/list`: returns the tool definitions from `TOOLS_JSON`
4. On `tools/call`: writes the call details to a **signaling file** in a temp directory, then blocks forever (never responds)

The gateway:
1. Creates a temp directory for signaling
2. Spawns the agent with the MCP server config
3. Monitors the signaling directory for new files (tool call requests)
4. After the collection window, kills the agent
5. Returns collected tool calls to the client

**Signaling mechanism**: The bridge writes each `tools/call` as a JSON file in the temp dir (e.g. `call_001.json`). The gateway polls the directory or uses `fs.watch()`.

This approach:
- Works in all isolation modes (direct, sandbox, Docker)
- Doesn't require network ports
- Uses only filesystem-based IPC (universally supported)
- The bridge script is self-contained and simple

#### Docker Compatibility

In Docker mode, the bridge script and signaling directory must be accessible inside the container:
- The bridge script is placed in the mounted workspace (`/workspace/.acp-bridge/bridge.mjs`)
- The signaling directory is also in the workspace (`/workspace/.acp-bridge/signals/`)
- The gateway monitors the host-side path (`${hostCwd}/.acp-bridge/signals/`)
- The `McpServerStdio` command inside Docker: `node /workspace/.acp-bridge/bridge.mjs`

### 2. Tool Call Collection Window

When the first tool call arrives, a timer starts (default: 500ms). Additional tool calls arriving within the window are batched. The window resets on each new call.

When the window expires:
1. Kill the ACP agent
2. Clean up the bridge files
3. Return all collected tool calls as an OpenAI-compatible response

### 3. System Prompt for Tool Bridge Mode

When tools are present in the request, the gateway replaces the default system prompt with one that instructs the agent to use only MCP tools:

```
You are a helpful AI assistant. You have access to tools provided via MCP.
When you need information (file contents, search results, etc.), use the
available MCP tools. Do NOT use built-in shell commands, file operations,
or web browsing — only use the provided MCP tools.
When you have enough information to answer, respond directly.
```

### 4. Mapping OpenAI Tools to MCP Tools

OpenAI tool format:
```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Read contents of a file",
    "parameters": {
      "type": "object",
      "properties": { "path": { "type": "string" } },
      "required": ["path"]
    }
  }
}
```

MCP tool format (tools/list response):
```json
{
  "name": "read_file",
  "description": "Read contents of a file",
  "inputSchema": {
    "type": "object",
    "properties": { "path": { "type": "string" } },
    "required": ["path"]
  }
}
```

The mapping is straightforward:
- `function.name` → `name`
- `function.description` → `description`
- `function.parameters` → `inputSchema`

### 5. Mapping MCP Tool Calls Back to OpenAI

MCP `tools/call` request:
```json
{
  "method": "tools/call",
  "params": { "name": "read_file", "arguments": { "path": "src/app.ts" } }
}
```

OpenAI tool_call format:
```json
{
  "id": "call_abc123",
  "type": "function",
  "function": {
    "name": "read_file",
    "arguments": "{\"path\": \"src/app.ts\"}"
  }
}
```

Note: OpenAI's `arguments` is a **JSON string**, not an object.

### 6. Text Before Tool Calls

The agent may emit text chunks before calling a tool. This text is accumulated and returned as the `content` field alongside `tool_calls`:

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": "Let me check that file for you...",
      "tool_calls": [...]
    }
  }]
}
```

In streaming mode, text chunks are sent as normal SSE events. When tool calls are detected, the final SSE event has `finish_reason: "tool_calls"`.

## Implementation Plan

### New Files

| File | Purpose |
|------|---------|
| `src/tool_bridge.ts` | Tool bridge logic: bridge script generation, signal monitoring, tool call collection |
| `src/mcp_bridge_server.mts` | Standalone MCP bridge script (spawned as child process by the agent) |

### Modified Files

| File | Changes |
|------|---------|
| `src/router_handler.ts` | Detect tools in request, activate bridge mode, return tool_calls |
| `src/runtime.ts` | Accept MCP server config in runStream, update StreamChunk for tool_calls |
| `src/serve.ts` | Format tool_calls in SSE and JSON responses |
| `src/client.ts` | No changes needed (tool calls detected via bridge, not client events) |

### StreamChunk Changes

```typescript
export interface ToolCallChunk {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface StreamChunk {
  finish_reason: string | null;  // "stop" | "tool_calls" | null
  index: number;
  is_finished: boolean;
  text: string;
  tool_calls?: ToolCallChunk[];  // present when finish_reason is "tool_calls"
  tool_use: null;
  usage: { ... } | null;
}
```

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TOOL_BRIDGE_ENABLED` | Enable tool bridge for requests with tools | `true` |
| `TOOL_BRIDGE_COLLECTION_WINDOW_MS` | Time to wait for additional tool calls after the first | `500` |
| `TOOL_BRIDGE_SYSTEM_PROMPT` | System prompt when tool bridge is active | *(see above)* |

## Limitations

1. **Agent may ignore MCP tools**: The system prompt is a soft constraint. The agent may still use internal tools. If it never calls an MCP tool, the response will be `finish_reason: "stop"` with a direct answer.

2. **Stateless between rounds**: Each round spawns a fresh agent session. Context is carried entirely in the message history.

3. **No streaming tool calls**: Tool calls are collected and returned as a batch. Individual tool calls are not streamed to the client as they arrive.

4. **Bridge script in workspace**: The MCP bridge script is written to the workspace directory, which the agent can theoretically read or modify. This is a minor concern since the bridge is read-only from the agent's perspective.
