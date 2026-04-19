import type { Adapter } from "./adapters/base.js";

export class Registry {
  private adapters = new Map<string, Adapter>();
  defaultAgent: string;

  constructor(defaultAgent = "kimi") {
    this.defaultAgent = defaultAgent.trim().toLowerCase();
  }

  register(adapter: Adapter): void {
    this.adapters.set(adapter.agentId, adapter);
  }

  get(agentId: string): Adapter | undefined {
    return this.adapters.get(agentId.trim().toLowerCase());
  }

  resolve(model: string, optionalParams: Record<string, unknown>): Adapter {
    const explicitAgent = String(optionalParams["agent"] ?? "")
      .trim()
      .toLowerCase();
    if (explicitAgent) {
      const adapter = this.get(explicitAgent);
      if (adapter) return adapter;
    }

    const normalized = String(model ?? "")
      .trim()
      .toLowerCase();
    const parts = normalized
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length >= 2 && parts[0] === "acp") {
      const adapter = this.get(parts[1]);
      if (adapter) return adapter;
    }

    // Handle "acp-{agent}" pattern (e.g. "acp-devin")
    if (normalized.startsWith("acp-")) {
      const agentName = normalized.slice(4);
      const adapter = this.get(agentName);
      if (adapter) return adapter;
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.matches(normalized)) return adapter;
      for (const alias of adapter.aliases) {
        if (alias && normalized.includes(alias)) return adapter;
      }
    }

    const defaultAdapter = this.get(this.defaultAgent);
    if (defaultAdapter) return defaultAdapter;

    if (this.adapters.size > 0) {
      return this.adapters.values().next().value!;
    }

    throw new Error("No adapters registered.");
  }
}
