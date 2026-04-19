export interface AgentSpec {
  agentId: string;
  bin: string;
  args: string[];
  modeId?: string;
  bootstrapCommands: string[];
}
