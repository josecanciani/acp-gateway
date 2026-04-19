# Adapters

Adapters are the extension point for connecting new ACP agents to the gateway.

## Built-in Adapters

### DevinAdapter

Connects to the [Devin](https://devin.ai) CLI agent.

- **Agent ID:** `devin`
- **Binary:** `devin`
- **Default args:** `["acp"]`
- **Aliases:** `devin-cli`, `cognition`
- **Env prefix:** `DEVIN`

### KimiAdapter

Connects to the Kimi CLI agent.

- **Agent ID:** `kimi`
- **Binary:** `kimi`
- **Default args:** `["acp"]`
- **Default mode:** `code`
- **Default bootstrap:** `/plan off`, `/yolo`
- **Aliases:** `moonshot`, `kimi-code`
- **Env prefix:** `KIMI`

## Creating a Custom Adapter

1. Create a new file in `src/adapters/` (e.g. `my-agent.ts`).
2. Extend `StaticAdapter`:

```typescript
import { StaticAdapter } from "./static.js";

export class MyAgentAdapter extends StaticAdapter {
  constructor() {
    super({
      agentId: "my-agent",
      defaultBin: "my-agent-cli",
      defaultArgs: ["acp"],
      defaultModeId: undefined,            // optional ACP session mode
      defaultBootstrapCommands: [],        // optional startup commands
      aliases: ["my-agent", "custom"],     // alternative model names
      envVarPrefix: "MY_AGENT",            // reads MY_AGENT_BIN, MY_AGENT_ARGS, etc.
    });
  }
}
```

3. Export it from `src/adapters/index.ts`:

```typescript
export { MyAgentAdapter } from "./my-agent.js";
```

4. Register it in `src/serve.ts`:

```typescript
import { MyAgentAdapter } from "./adapters/index.js";

registry.register(new MyAgentAdapter());
```

After registration, the agent is available via model names like `acp/my-agent`, `acp-my-agent`, or any of its aliases.

## Adapter Interface

All adapters implement the `Adapter` interface:

```typescript
interface Adapter {
  agentId: string;
  aliases: string[];
  matches(value: string): boolean;
  buildSpec(optionalParams: Record<string, unknown>): AgentSpec;
}
```

- **`agentId`** -- unique identifier, used in model routing
- **`aliases`** -- alternative names that route to this adapter
- **`matches(value)`** -- returns `true` if `value` matches this adapter (case-insensitive check against `agentId` and `aliases`)
- **`buildSpec(optionalParams)`** -- builds an `AgentSpec` by resolving the three-tier config hierarchy (request params -> env vars -> defaults)

## Configuration Hierarchy

`StaticAdapter.buildSpec()` resolves each setting from:

1. **Request `optional_params`** -- keys like `{agentId}_bin`, `agent_bin`
2. **Environment variables** -- keys like `{ENVVARPREFIX}_BIN`
3. **Adapter defaults** -- values passed to the constructor

See [configuration.md](configuration.md) for the complete reference.

## AgentSpec

The `AgentSpec` object is what the runtime uses to spawn and configure the agent:

```typescript
interface AgentSpec {
  agentId: string;           // Agent identifier
  bin: string;               // Binary to spawn
  args: string[];            // CLI arguments
  modeId?: string;           // ACP session mode (optional)
  bootstrapCommands: string[]; // Commands run before the user prompt
}
```
