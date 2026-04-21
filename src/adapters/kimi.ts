import { StaticAdapter } from "./static.js";

export class KimiAdapter extends StaticAdapter {
  constructor() {
    super({
      agentId: "kimi",
      defaultBin: "kimi",
      defaultArgs: ["acp"],
      defaultModeId: "code",
      defaultBootstrapCommands: ["/plan off", "/yolo"],
      aliases: ["moonshot", "kimi-code"],
      envVarPrefix: "KIMI",
      sandbox: true,
    });
  }
}
