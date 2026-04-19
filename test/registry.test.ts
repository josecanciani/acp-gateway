import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/registry.js";
import { KimiAdapter, DevinAdapter } from "../src/adapters/index.js";

describe("Registry", () => {
  it("resolves acp/devin model to DevinAdapter", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const adapter = registry.resolve("acp/devin", {});
    assert.equal(adapter.agentId, "devin");
  });

  it("resolves acp-devin model to DevinAdapter", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const adapter = registry.resolve("acp-devin", {});
    assert.equal(adapter.agentId, "devin");
  });

  it("resolves acp/kimi model to KimiAdapter", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const adapter = registry.resolve("acp/kimi", {});
    assert.equal(adapter.agentId, "kimi");
  });

  it("resolves explicit agent param over model name", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const adapter = registry.resolve("acp/kimi", { agent: "devin" });
    assert.equal(adapter.agentId, "devin");
  });

  it("resolves alias 'cognition' to DevinAdapter", () => {
    const registry = new Registry("kimi");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const adapter = registry.resolve("cognition", {});
    assert.equal(adapter.agentId, "devin");
  });

  it("falls back to default agent for unknown model", () => {
    const registry = new Registry("devin");
    registry.register(new KimiAdapter());
    registry.register(new DevinAdapter());

    const adapter = registry.resolve("unknown-model", {});
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

    const adapter = registry.resolve("ACP/DEVIN", {});
    assert.equal(adapter.agentId, "devin");
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
