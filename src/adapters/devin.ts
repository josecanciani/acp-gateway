import { StaticAdapter } from "./static.js";

export class DevinAdapter extends StaticAdapter {
  constructor() {
    super({
      agentId: "devin",
      defaultBin: "devin",
      defaultArgs: ["acp"],
      defaultModeId: undefined,
      defaultBootstrapCommands: [],
      aliases: ["devin-cli", "cognition"],
      envVarPrefix: "DEVIN",
    });
  }
}
