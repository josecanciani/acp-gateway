#!/usr/bin/env node
/**
 * Mock ACP agent for integration testing.
 *
 * Speaks the ACP protocol over stdio, returning deterministic responses.
 * Spawned as a subprocess by the router during tests.
 *
 * Behaviour is controlled by the prompt text:
 *   - Contains "echo:"  -> echoes everything after "echo:" back
 *   - Contains "error"  -> throws an error during prompt
 *   - Contains "slow"   -> waits 2 s before responding
 *   - Contains "multi"  -> sends two message chunks
 *   - Contains "permission" -> requests permission before responding
 *   - Otherwise          -> replies with "mock-response"
 */
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type AuthenticateRequest,
  type SetSessionModeRequest,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import crypto from "node:crypto";

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractPromptText(prompt: PromptRequest["prompt"]): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null && "text" in block)
        return String((block as { text: string }).text);
      return "";
    })
    .join("")
    .trim();
}

class MockAgent implements Agent {
  private connection: AgentSideConnection;
  private sessions = new Map<string, { pendingPrompt: AbortController | null }>();

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomId();
    this.sessions.set(sessionId, { pendingPrompt: null });
    return { sessionId };
  }

  async authenticate(_params: AuthenticateRequest): Promise<Record<string, unknown>> {
    return {};
  }

  async setSessionMode(_params: SetSessionModeRequest): Promise<Record<string, unknown>> {
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    const text = extractPromptText(params.prompt);

    try {
      if (text.includes("error")) {
        throw new Error("mock agent error");
      }

      if (text.includes("slow")) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (text.includes("multi")) {
        await this.sendText(params.sessionId, "chunk-1");
        await this.sendText(params.sessionId, "chunk-2");
      } else if (text.includes("echo:")) {
        const echoText = text.split("echo:")[1].trim();
        await this.sendText(params.sessionId, echoText);
      } else if (text.includes("permission")) {
        const resp = await this.connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: "call_test",
            title: "Test operation",
            kind: "edit",
            status: "pending",
            locations: [{ path: "/test/file.txt" }],
            rawInput: { path: "/test/file.txt" },
          },
          options: [
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
        });
        if (resp.outcome.outcome === "selected" && resp.outcome.optionId === "allow") {
          await this.sendText(params.sessionId, "permission-granted");
        } else {
          await this.sendText(params.sessionId, "permission-denied");
        }
      } else {
        await this.sendText(params.sessionId, "mock-response");
      }
    } catch (err) {
      if (session.pendingPrompt?.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw err;
    }

    session.pendingPrompt = null;
    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  private async sendText(sessionId: string, text: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
}

const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);
new AgentSideConnection((conn) => new MockAgent(conn), stream);
