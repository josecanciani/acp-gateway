import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/registry.js";
import { KimiAdapter, DevinAdapter } from "../src/adapters/index.js";

describe("Registry", () => {
  it("resolves acp/devin model to DevinAdapter", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const { adapter } = registry.resolve("acp/devin", {});
    assert.equal(adapter.agentId, "devin");
  });

  it("resolves acp-devin model to DevinAdapter", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const { adapter } = registry.resolve("acp-devin", {});
    assert.equal(adapter.agentId, "devin");
  });

  it("resolves acp/kimi model to KimiAdapter", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const { adapter } = registry.resolve("acp/kimi", {});
    assert.equal(adapter.agentId, "kimi");
  });

  it("resolves explicit agent param over model name", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const { adapter } = registry.resolve("acp/kimi", { agent: "devin" });
    assert.equal(adapter.agentId, "devin");
  });

  it("resolves alias 'cognition' to DevinAdapter", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const { adapter } = registry.resolve("cognition", {});
    assert.equal(adapter.agentId, "devin");
  });

  it("falls back to default agent for unknown model", () => {
    const registry = new Registry("devin");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const { adapter } = registry.resolve("unknown-model", {});
    assert.equal(adapter.agentId, "devin");
  });

  it("throws when no adapters registered", () => {
    const registry = new Registry("kimi");
    assert.throws(() => registry.resolve("anything", {}), /No adapters registered/);
  });

  it("is case-insensitive", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const { adapter } = registry.resolve("ACP/DEVIN", {});
    assert.equal(adapter.agentId, "devin");
  });
});

describe("Registry model routing", () => {
  it("resolves devin/{modelId} when model is known", () => {
    const registry = new Registry("kimi");
    registry.register(new DevinAdapter());
    registry.setModels("devin", [
      { modelId: "claude-opus-4", name: "Claude Opus" },
      { modelId: "gpt-4o", name: "GPT 4o" },
    ]);

    const { adapter, modelId } = registry.resolve("devin/claude-opus-4", {});
    assert.equal(adapter.agentId, "devin");
    assert.equal(modelId, "claude-opus-4");
  });

  it("resolves devin/{modelId} case-insensitively", () => {
    const registry = new Registry("kimi");
    registry.register(new DevinAdapter());
    registry.setModels("devin", [{ modelId: "Claude-Opus-4", name: "Claude Opus" }]);

    const { adapter, modelId } = registry.resolve("devin/claude-opus-4", {});
    assert.equal(adapter.agentId, "devin");
    assert.equal(modelId, "claude-opus-4");
  });

  it("falls back to adapter when model is unknown", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());
    registry.setModels("devin", [{ modelId: "claude-opus-4", name: "Claude Opus" }]);

    const { adapter, modelId } = registry.resolve("devin/unknown-model", {});
    assert.equal(adapter.agentId, "devin");
    assert.equal(modelId, undefined);
  });

  it("acp/devin still works when models are discovered", () => {
    const registry = new Registry("kimi");
    registry.register(new DevinAdapter());
    registry.setModels("devin", [{ modelId: "claude-opus-4", name: "Claude Opus" }]);

    const { adapter, modelId } = registry.resolve("acp/devin", {});
    assert.equal(adapter.agentId, "devin");
    assert.equal(modelId, undefined);
  });

  it("listAllModels returns prefixed models", () => {
    const registry = new Registry("kimi");
    registry.register(new DevinAdapter());
    registry.setModels("devin", [
      { modelId: "claude-opus-4", name: "Claude Opus" },
      { modelId: "gpt-4o", name: "GPT 4o" },
    ]);

    const models = registry.listAllModels();
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "devin/claude-opus-4");
    assert.equal(models[1].id, "devin/gpt-4o");
  });

  it("listAllModels returns empty when no models cached", () => {
    const registry = new Registry("kimi");
    registry.register(new DevinAdapter());

    const models = registry.listAllModels();
    assert.equal(models.length, 0);
  });
});

describe("Adapters", () => {
  it("DevinAdapter builds correct spec with defaults", () => {
    const adapter = new DevinAdapter();
    const spec = adapter.buildSpec({});

    assert.equal(spec.agentId, "devin");
    assert.equal(spec.bin, "devin");
    assert.deepEqual(spec.args, ["acp"]);
    assert.equal(spec.modeId, undefined);
    assert.deepEqual(spec.bootstrapCommands, []);
  });

  it("KimiAdapter builds correct spec with defaults", () => {
    const adapter = new KimiAdapter();
    const spec = adapter.buildSpec({});

    assert.equal(spec.agentId, "kimi");
    assert.equal(spec.bin, "kimi");
    assert.deepEqual(spec.args, ["acp"]);
    assert.equal(spec.modeId, "code");
    assert.deepEqual(spec.bootstrapCommands, ["/plan off", "/yolo"]);
  });

  it("StaticAdapter respects env var overrides", () => {
    process.env.DEVIN_BIN = "/custom/devin";
    const adapter = new DevinAdapter();
    const spec = adapter.buildSpec({});
    assert.equal(spec.bin, "/custom/devin");
    delete process.env.DEVIN_BIN;
  });

  it("StaticAdapter respects optional_params overrides", () => {
    const adapter = new DevinAdapter();
    const spec = adapter.buildSpec({ devin_bin: "/other/devin" });
    assert.equal(spec.bin, "/other/devin");
  });
});
