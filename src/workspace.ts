import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WorkspaceInfo {
  /** Unique conversation ID (user-provided or generated) */
  conversationId: string;
  /** Random token for artifact URLs (not the same as conversationId) */
  token: string;
  /** Absolute path to the conversation root (used as agent HOME) */
  homeDir: string;
  /** Absolute path to the workspace directory (homeDir/workspace, agent CWD) */
  dir: string;
  /** Timestamp of last activity (epoch ms) */
  lastActivity: number;
}

/**
 * Manages per-conversation directories.
 *
 * Each conversation gets a unique directory (`homeDir`) that serves as
 * the agent's isolated HOME. Inside it:
 * - `workspace/` is the agent's CWD where project files and artifacts live
 * - `.config/devin/` holds the bridge config (written by the runtime)
 * - `.local/share/devin/` holds copied credentials (written by the runtime)
 *
 * The entire `homeDir` is cleaned up when the conversation expires.
 */
export class WorkspaceManager {
  private workspaces = new Map<string, WorkspaceInfo>();
  /** Reverse lookup: token → conversationId */
  private tokenIndex = new Map<string, string>();
  readonly baseDir: string;
  private ttlMs: number;

  constructor(baseDir?: string, ttlMs?: number) {
    const xdgDataHome =
      process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "/tmp", ".local", "share");
    this.baseDir =
      baseDir ??
      process.env.WORKSPACE_BASE_DIR ??
      path.join(xdgDataHome, "acp-gateway", "workspaces");
    this.ttlMs = ttlMs ?? parseInt(process.env.WORKSPACE_TTL_MS ?? String(3600_000), 10);
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** Get or create a workspace for the given conversation ID. */
  getOrCreate(conversationId?: string): WorkspaceInfo {
    // Resolve existing workspace
    if (conversationId) {
      const existing = this.workspaces.get(conversationId);
      if (existing) {
        existing.lastActivity = Date.now();
        return existing;
      }
    }

    // Generate new conversation ID if not provided
    const id = conversationId || randomBytes(16).toString("hex");
    const token = randomBytes(16).toString("hex");
    const homeDir = path.join(this.baseDir, id);
    const dir = path.join(homeDir, "workspace");
    mkdirSync(dir, { recursive: true });

    const info: WorkspaceInfo = {
      conversationId: id,
      token,
      homeDir,
      dir,
      lastActivity: Date.now(),
    };

    this.workspaces.set(id, info);
    this.tokenIndex.set(token, id);
    return info;
  }

  /** Resolve a workspace by its artifact token. Returns null if expired or unknown. */
  getByToken(token: string): WorkspaceInfo | null {
    const conversationId = this.tokenIndex.get(token);
    if (!conversationId) return null;
    const ws = this.workspaces.get(conversationId);
    if (!ws) return null;
    if (Date.now() - ws.lastActivity > this.ttlMs) {
      this.expire(conversationId);
      return null;
    }
    return ws;
  }

  /**
   * Materialize uploaded files into the workspace.
   * Handles OpenAI content blocks with image_url (data URIs) and file attachments.
   * Returns paths of files written (relative to workspace).
   */
  materializeFiles(
    ws: WorkspaceInfo,
    messages: Array<{ role?: string; content?: unknown }>,
  ): string[] {
    const written: string[] = [];

    for (const msg of messages) {
      if (!msg.content || !Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (typeof block !== "object" || block === null) continue;
        const obj = block as Record<string, unknown>;

        // Handle image_url with data URI (base64-encoded)
        if (obj.type === "image_url") {
          const imageUrl = obj.image_url as { url?: string } | undefined;
          const url = imageUrl?.url ?? (obj.url as string | undefined);
          if (!url) continue;

          const file = this.saveDataUri(ws, url, `upload_${written.length}`);
          if (file) written.push(file);
          continue;
        }

        // Handle file attachment (some clients send type: "file")
        if (obj.type === "file") {
          const fileData = obj.file as
            | { data?: string; name?: string; mime_type?: string }
            | undefined;
          if (!fileData?.data) continue;
          const name = fileData.name ?? `file_${written.length}`;
          const filePath = path.join("uploads", name);
          const absPath = path.join(ws.dir, filePath);
          mkdirSync(path.dirname(absPath), { recursive: true });
          writeFileSync(absPath, Buffer.from(fileData.data, "base64"));
          written.push(filePath);
        }
      }
    }

    return written;
  }

  /** List all files in the workspace (relative paths). */
  listFiles(ws: WorkspaceInfo): string[] {
    const files: string[] = [];
    this.walkDir(ws.dir, ws.dir, files);
    return files;
  }

  /** Resolve absolute path for a relative file within a workspace. Returns null if outside workspace. */
  resolveFilePath(ws: WorkspaceInfo, relativePath: string): string | null {
    const resolved = path.resolve(ws.dir, relativePath);
    if (!resolved.startsWith(ws.dir)) return null;
    if (!existsSync(resolved)) return null;
    return resolved;
  }

  /** Remove expired workspaces. */
  gc(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, ws] of this.workspaces) {
      if (now - ws.lastActivity > this.ttlMs) {
        this.expire(id);
        removed++;
      }
    }
    return removed;
  }

  private expire(conversationId: string): void {
    const ws = this.workspaces.get(conversationId);
    if (!ws) return;
    this.tokenIndex.delete(ws.token);
    this.workspaces.delete(conversationId);
    try {
      rmSync(ws.homeDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  private saveDataUri(ws: WorkspaceInfo, dataUri: string, fallbackName: string): string | null {
    // data:image/png;base64,iVBOR...
    const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;

    const mimeType = match[1];
    const data = match[2];
    const ext = mimeToExt(mimeType);
    const filename = `${fallbackName}${ext}`;
    const filePath = path.join("uploads", filename);
    const absPath = path.join(ws.dir, filePath);

    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, Buffer.from(data, "base64"));
    return filePath;
  }

  private walkDir(dir: string, root: string, results: string[]): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(full, root, results);
      } else {
        results.push(path.relative(root, full));
      }
    }
  }
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "application/json": ".json",
  };
  return map[mime] ?? "";
}
