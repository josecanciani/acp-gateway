export interface AgentSpec {
  agentId: string;
  bin: string;
  args: string[];
  modeId?: string;
  modelId?: string;
  bootstrapCommands: string[];
}

export interface DiscoveredModel {
  modelId: string;
  name: string;
  description?: string;
}
