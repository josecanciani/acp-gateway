import type { AgentSpec } from "../schemas.js";

export interface Adapter {
  agentId: string;
  aliases: string[];
  matches(value: string): boolean;
  buildSpec(optionalParams: Record<string, unknown>): AgentSpec;
}

export function baseMatches(
  adapter: { agentId: string; aliases: string[] },
  value: string,
): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === adapter.agentId || adapter.aliases.includes(normalized);
}
