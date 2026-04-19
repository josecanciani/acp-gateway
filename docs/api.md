# API Reference

acp-gateway exposes an OpenAI-compatible HTTP API. All endpoints accept and return JSON unless otherwise noted.

## Endpoints

### GET /health

Health check.

**Response:**

```json
{ "status": "ok" }
```

---

### GET /v1/models

List available models. Returns both base adapter models and dynamically discovered per-agent models.

**Response:**

```json
{
  "data": [
    { "id": "acp-kimi", "object": "model", "created": 1677610602, "owned_by": "acp-router" },
    { "id": "acp-devin", "object": "model", "created": 1677610602, "owned_by": "acp-router" },
    { "id": "devin/claude-opus-4", "object": "model", "created": 1677610602, "owned_by": "devin" },
    { "id": "devin/gpt-4o", "object": "model", "created": 1677610602, "owned_by": "devin" }
  ],
  "object": "list"
}
```

Base adapter models use `"owned_by": "acp-router"`. Discovered per-agent models use the agent ID as the owner (e.g. `"owned_by": "devin"`).

---

### POST /v1/chat/completions

Send a chat completion request. Supports both streaming (SSE) and non-streaming modes.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No | Model/agent to use (default: `acp/kimi`). Supports `{agentId}/{modelId}` format (e.g. `devin/claude-opus-4`) to select a specific underlying model. See [configuration.md](configuration.md) for routing rules. |
| `messages` | array | Yes | Array of message objects (`{ role, content }`). |
| `stream` | boolean | No | Enable SSE streaming (default: `false`). |
| `tools` | array | No | Tool definitions (passed as hints to the agent). |

Any additional fields are forwarded as `optional_params` to the adapter.

**Non-streaming response:**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "acp/devin",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello! How can I help?" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

**Streaming response:**

Returns `Content-Type: text/event-stream`. Each event is a JSON object prefixed with `data: `:

```
data: {"id":"chatcmpl-abc123","created":1700000000,"model":"acp/devin","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello","role":"assistant"}}]}

data: {"id":"chatcmpl-abc124","created":1700000000,"model":"acp/devin","object":"chat.completion.chunk","choices":[{"finish_reason":"stop","index":0,"delta":{}}]}

data: [DONE]
```

**Error response:**

```json
{
  "error": {
    "message": "Error description",
    "type": "internal_error"
  }
}
```

## Message Format

Messages follow the OpenAI chat format:

```json
[
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "user", "content": "Write a hello world program." },
  { "role": "assistant", "content": "Here it is..." },
  { "role": "tool", "content": "result data", "name": "tool_name" }
]
```

The gateway also accepts an alternative request format with `input` and `instructions` fields instead of `messages`:

```json
{
  "model": "acp/devin",
  "input": "Write a hello world program.",
  "instructions": "Be concise."
}
```

## Client Compatibility

The API is designed to be a drop-in replacement for OpenAI's `/v1/chat/completions` endpoint. It works with:

- OpenAI client libraries (Python, Node.js, etc.) by changing the `base_url`
- `curl` and other HTTP clients
- Any tool that supports OpenAI-compatible APIs (IDE extensions, chat UIs, etc.)

Example with the OpenAI Python client:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4001/v1", api_key="unused")
response = client.chat.completions.create(
    model="acp/devin",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

---

### GET /v1/artifacts/:token

List all files in a conversation workspace.

**Response:**

```json
{
  "files": ["output.py", "data/results.json"]
}
```

Returns `404` if the token is invalid or the workspace has expired.

---

### GET /v1/artifacts/:token/*filepath

Download a specific file from a conversation workspace.

**Response:** The raw file content with an appropriate `Content-Type` header.

Returns `404` if the token is invalid, the file does not exist, or the path attempts directory traversal.

---

## Conversation Continuity

Use the `X-Conversation-Id` header or `conversation_id` body field to maintain workspace state across multiple requests in the same conversation.

| Mechanism | Direction | Description |
|-----------|-----------|-------------|
| `X-Conversation-Id` header | Request | Pass an existing conversation ID to reuse a workspace |
| `conversation_id` body field | Request | Alternative to the header |
| `X-Conversation-Id` header | Response | Always returned — use for subsequent requests |
| `conversation_id` field | Response (non-streaming) | Included in the JSON response body |
| `artifacts` field | Response (non-streaming) | `{ token, files[] }` for accessing workspace files |
| Final SSE event | Response (streaming) | Artifact metadata emitted before `[DONE]` |
