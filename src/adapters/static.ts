import type { AgentSpec } from "../schemas.js";
import { type Adapter, baseMatches } from "./base.js";

function coerceList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [String(value)];
}

export class StaticAdapter implements Adapter {
  agentId: string;
  defaultBin: string;
  defaultArgs: string[];
  defaultModeId?: string;
  defaultBootstrapCommands: string[];
  aliases: string[];
  envVarPrefix: string;

  constructor(opts: {
    agentId: string;
    defaultBin: string;
    defaultArgs: string[];
    defaultModeId?: string;
    defaultBootstrapCommands?: string[];
    aliases?: string[];
    envVarPrefix?: string;
  }) {
    this.agentId = opts.agentId.trim().toLowerCase();
    this.defaultBin = opts.defaultBin;
    this.defaultArgs = [...opts.defaultArgs];
    this.defaultModeId = opts.defaultModeId;
    this.defaultBootstrapCommands = [...(opts.defaultBootstrapCommands ?? [])];
    this.aliases = (opts.aliases ?? []).map((a) => a.trim().toLowerCase());
    this.envVarPrefix = (opts.envVarPrefix ?? opts.agentId).toUpperCase().replace(/-/g, "_");
  }

  matches(value: string): boolean {
    return baseMatches(this, value);
  }

  buildSpec(optionalParams: Record<string, unknown>): AgentSpec {
    const bin =
      (optionalParams[`${this.agentId}_bin`] as string) ??
      (optionalParams["agent_bin"] as string) ??
      process.env[`${this.envVarPrefix}_BIN`] ??
      this.defaultBin;

    const argsValue =
      optionalParams[`${this.agentId}_args`] ??
      optionalParams["agent_args"] ??
      process.env[`${this.envVarPrefix}_ARGS`];
    const args = argsValue ? coerceList(argsValue) : [...this.defaultArgs];

    const modeId =
      (optionalParams[`${this.agentId}_mode_id`] as string) ??
      (optionalParams["agent_mode_id"] as string) ??
      process.env[`${this.envVarPrefix}_MODE_ID`] ??
      this.defaultModeId;

    const bootstrapValue =
      optionalParams[`${this.agentId}_bootstrap_commands`] ?? optionalParams["bootstrap_commands"];
    const bootstrapCommands =
      bootstrapValue != null ? coerceList(bootstrapValue) : [...this.defaultBootstrapCommands];

    return {
      agentId: this.agentId,
      bin: String(bin),
      args: args.map(String),
      modeId: modeId ? String(modeId) : undefined,
      bootstrapCommands: bootstrapCommands.map(String),
    };
  }
}
