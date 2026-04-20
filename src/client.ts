import path from "node:path";
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { pickPermissionOption } from "./utils.js";

export interface TextEvent {
  kind: string;
  text: string;
}

export interface TrackedFile {
  path: string;
  kind: string;
  toolCallId: string;
}

/**
 * ACP Client implementation that handles agent communication.
 * Port of the Python AgentClient class.
 */
export class AgentClient implements Client {
  queue: TextEvent[] = [];
  private waiters: Array<(event: TextEvent) => void> = [];
  finalTextParts: string[] = [];
  suppressStream = false;
  permissionMode: string;
  /** Files touched by tool calls during this session. */
  trackedFiles: TrackedFile[] = [];
  /**
   * When set, permission requests for paths outside this directory are denied.
   * Works in all isolation modes as the baseline defence layer.
   */
  workspaceDir?: string;

  constructor(permissionMode = "auto_allow", workspaceDir?: string) {
    this.permissionMode = permissionMode.trim().toLowerCase();
    this.workspaceDir = workspaceDir;
  }

  /** Push an event to the queue, or wake a waiting consumer. */
  private pushEvent(event: TextEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.queue.push(event);
    }
  }

  /** Pull an event from the queue, or wait with a timeout. Returns null on timeout. */
  pullEvent(timeoutMs = 100): Promise<TextEvent | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise<TextEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiterFn);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const waiterFn = (event: TextEvent) => {
        clearTimeout(timer);
        resolve(event);
      };
      this.waiters.push(waiterFn);
    });
  }

  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (["cancel", "deny", "reject"].includes(this.permissionMode)) {
      return { outcome: { outcome: "cancelled" } };
    }

    // Workspace-scoped permission filtering: deny paths outside the workspace
    if (this.workspaceDir && !this.isPathAllowed(params)) {
      return { outcome: { outcome: "cancelled" } };
    }

    const options = Array.isArray(params.options) ? params.options : [];
    const chosenOptionId = pickPermissionOption(
      options.map((o) => ({
        optionId: o.optionId,
        kind: o.kind,
      })),
    );

    if (chosenOptionId) {
      return {
        outcome: {
          outcome: "selected",
          optionId: chosenOptionId,
        },
      };
    }

    return { outcome: { outcome: "cancelled" } };
  }

  /**
   * Check whether a permission request targets a path within the workspace.
   * Returns true (allowed) when no path can be extracted (non-file operations)
   * or when the path is inside workspaceDir.
   */
  private isPathAllowed(params: RequestPermissionRequest): boolean {
    const requestedPaths = this.extractPaths(params);
    if (requestedPaths.length === 0) return true; // non-path permissions are allowed

    const wsDir = path.resolve(this.workspaceDir!);
    for (const p of requestedPaths) {
      const resolved = path.resolve(p);
      if (!resolved.startsWith(wsDir + path.sep) && resolved !== wsDir) {
        return false;
      }
    }
    return true;
  }

  /**
   * Extract file paths from a permission request.
   * Looks in toolCall.locations[].path and toolCall.rawInput.path.
   */
  private extractPaths(params: RequestPermissionRequest): string[] {
    const paths: string[] = [];
    const tc = params.toolCall as Record<string, unknown> | undefined;
    if (!tc) return paths;

    const locations = tc.locations as Array<{ path?: string }> | undefined;
    if (Array.isArray(locations)) {
      for (const loc of locations) {
        if (typeof loc?.path === "string" && loc.path.trim()) {
          paths.push(loc.path.trim());
        }
      }
    }

    const rawInput = tc.rawInput as Record<string, unknown> | undefined;
    if (rawInput) {
      for (const key of ["path", "file_path", "directory", "dir", "cwd"]) {
        const val = rawInput[key];
        if (typeof val === "string" && val.trim()) paths.push(val.trim());
      }
    }

    return paths;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update as Record<string, unknown>;
    if (!update || typeof update !== "object") return;

    const updateKind = String(update.sessionUpdate ?? update.session_update ?? "").trim();

    if (updateKind === "agent_thought_chunk") return;

    if (updateKind === "agent_message_chunk") {
      const text = this.contentBlockToText(update.content);
      if (text) {
        if (this.suppressStream) return;
        this.finalTextParts.push(text);
        this.pushEvent({ kind: "assistant_text", text });
      }
      return;
    }

    if (updateKind === "tool_call" || updateKind === "tool_call_update") {
      this.trackLocations(update);
    }
  }

  private contentBlockToText(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value;

    if (typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (obj.type === "text") return String(obj.text ?? "");
      if ("text" in obj) return String(obj.text ?? "");
      if ("content" in obj) return this.contentBlockToText(obj.content);
      return "";
    }

    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          if (obj.type === "text") {
            const text = String(obj.text ?? "");
            if (text) parts.push(text);
          } else if ("content" in obj) {
            const text = this.contentBlockToText(obj.content);
            if (text) parts.push(text);
          } else if ("text" in obj) {
            const text = String(obj.text ?? "");
            if (text) parts.push(text);
          }
        } else if (typeof item === "string" && item) {
          parts.push(item);
        }
      }
      return parts.join("");
    }

    return "";
  }

  getFinalText(): string {
    return this.finalTextParts.join("").trim();
  }

  /** Extract file locations from tool_call or tool_call_update events. */
  private trackLocations(update: Record<string, unknown>): void {
    const toolCallId = String(update.toolCallId ?? "");
    const kind = String(update.kind ?? "other");
    const locations = update.locations as Array<{ path?: string }> | undefined;
    if (!Array.isArray(locations)) return;

    for (const loc of locations) {
      const p = typeof loc?.path === "string" ? loc.path.trim() : "";
      if (!p) continue;
      // Avoid duplicates
      if (this.trackedFiles.some((f) => f.path === p && f.toolCallId === toolCallId)) continue;
      this.trackedFiles.push({ path: p, kind, toolCallId });
    }
  }

  /** Handle vendor-specific notifications (e.g. _cognition.ai/agent_stopped). */
  async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {
    // Silently ignore unknown notifications
  }
}
