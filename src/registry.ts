import type { Adapter } from "./adapters/base.js";
import type { DiscoveredModel } from "./schemas.js";

export interface ResolvedRoute {
  adapter: Adapter;
  modelId?: string;
}

export class Registry {
  private adapters = new Map<string, Adapter>();
  private modelCache = new Map<string, DiscoveredModel[]>();
  private availableAgents = new Set<string>();
  discoveryDone = false;
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

  /** Store discovered models for an adapter (call after model discovery). */
  setModels(agentId: string, models: DiscoveredModel[]): void {
    this.modelCache.set(agentId.trim().toLowerCase(), models);
  }

  /** Get cached models for an adapter. */
  getModels(agentId: string): DiscoveredModel[] {
    return this.modelCache.get(agentId.trim().toLowerCase()) ?? [];
  }

  /** Get all models from all adapters, prefixed with the agent id. */
  listAllModels(): Array<{
    id: string;
    agentId: string;
    modelId: string;
    name: string;
    description?: string;
  }> {
    const result: Array<{
      id: string;
      agentId: string;
      modelId: string;
      name: string;
      description?: string;
    }> = [];
    for (const [agentId, models] of this.modelCache) {
      for (const m of models) {
        result.push({
          id: `${agentId}/${m.modelId}`,
          agentId,
          modelId: m.modelId,
          name: m.name,
          description: m.description,
        });
      }
    }
    return result;
  }

  /** Mark an agent as available (reachable during discovery). */
  markAvailable(agentId: string): void {
    this.availableAgents.add(agentId.trim().toLowerCase());
  }

  /** Check if an agent was found available during discovery. */
  isAvailable(agentId: string): boolean {
    return this.availableAgents.has(agentId.trim().toLowerCase());
  }

  /** List all registered adapters. If discovery has completed, only return available ones. */
  listAdapters(): Adapter[] {
    if (!this.discoveryDone) return [...this.adapters.values()];
    return [...this.adapters.values()].filter((a) => this.availableAgents.has(a.agentId));
  }

  resolve(model: string, optionalParams: Record<string, unknown>): ResolvedRoute {
    const explicitAgent = String(optionalParams["agent"] ?? "")
      .trim()
      .toLowerCase();
    if (explicitAgent) {
      const adapter = this.get(explicitAgent);
      if (adapter) return { adapter };
    }

    const normalized = String(model ?? "")
      .trim()
      .toLowerCase();
    const parts = normalized
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);

    // Handle "{agentId}/{modelId}" — e.g. "devin/claude-opus-4"
    if (parts.length >= 2) {
      const adapter = this.get(parts[0]);
      if (adapter) {
        const modelId = parts.slice(1).join("/");
        const knownModels = this.getModels(adapter.agentId);
        if (knownModels.some((m) => m.modelId.toLowerCase() === modelId.toLowerCase())) {
          return { adapter, modelId };
        }
        // Agent matched but model unknown — route to adapter without model selection
        return { adapter };
      }
      // Legacy "acp/{agentId}" pattern
      if (parts[0] === "acp") {
        const adapter = this.get(parts[1]);
        if (adapter) return { adapter };
      }
    }

    // Handle "acp-{agent}" pattern (e.g. "acp-devin")
    if (normalized.startsWith("acp-")) {
      const agentName = normalized.slice(4);
      const adapter = this.get(agentName);
      if (adapter) return { adapter };
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.matches(normalized)) return { adapter };
      for (const alias of adapter.aliases) {
        if (alias && normalized.includes(alias)) return { adapter };
      }
    }

    const defaultAdapter = this.get(this.defaultAgent);
    if (defaultAdapter) return { adapter: defaultAdapter };

    if (this.adapters.size > 0) {
      return { adapter: this.adapters.values().next().value! };
    }

    throw new Error("No adapters registered.");
  }
}
