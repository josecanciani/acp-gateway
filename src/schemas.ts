export interface AgentSpec {
  agentId: string;
  bin: string;
  args: string[];
  modeId?: string;
  modelId?: string;
  bootstrapCommands: string[];
  /** Whether the CLI supports the --sandbox flag for OS-level isolation. */
  sandbox?: boolean;
}

export interface DiscoveredModel {
  modelId: string;
  name: string;
  description?: string;
}
