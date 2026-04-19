import { existsSync, statSync } from "node:fs";
import path from "node:path";

export interface Message {
  role: string;
  content: unknown;
  name?: string;
}

export interface ToolDef {
  type?: string;
  function?: { name?: string };
}

export function pickPermissionOption(
  options: Array<{ optionId?: string; kind?: string }>,
): string | null {
  const normalized = (options ?? [])
    .filter((o): o is { optionId: string; kind: string } => typeof o === "object" && o !== null)
    .map((o) => ({
      optionId: String(o.optionId ?? "").trim(),
      kind: String(o.kind ?? "")
        .trim()
        .toLowerCase(),
    }));

  for (const preferred of ["allow_always", "allow_once"]) {
    for (const opt of normalized) {
      if (opt.kind === preferred && opt.optionId) return opt.optionId;
    }
  }

  for (const opt of normalized) {
    if (opt.kind.includes("allow") && opt.optionId) return opt.optionId;
  }

  return null;
}

export function contentBlocksToText(content: unknown): string {
  if (content == null) return "";

  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        const txt = item.trim();
        if (txt) parts.push(txt);
        continue;
      }

      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const itemType = String(obj.type ?? "")
        .trim()
        .toLowerCase();

      if (["text", "input_text", "output_text"].includes(itemType)) {
        const txt = String(obj.text ?? "").trim();
        if (txt) parts.push(txt);
        continue;
      }

      if ("content" in obj) {
        const txt = contentBlocksToText(obj.content);
        if (txt) parts.push(txt);
        continue;
      }

      if ("text" in obj) {
        const txt = String(obj.text ?? "").trim();
        if (txt) parts.push(txt);
      }
    }
    return parts.filter(Boolean).join("\n").trim();
  }

  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    const itemType = String(obj.type ?? "")
      .trim()
      .toLowerCase();

    if (["text", "input_text", "output_text"].includes(itemType)) {
      return String(obj.text ?? "").trim();
    }

    if ("content" in obj) return contentBlocksToText(obj.content);
    if ("text" in obj) return String(obj.text ?? "").trim();
  }

  return String(content).trim();
}

export function responsesInputToMessages(
  inputValue: unknown,
  instructions?: string,
  existingMessages?: Message[],
): Message[] {
  const messages: Message[] = [];

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (existingMessages) {
    messages.push(...existingMessages);
  }

  if (inputValue == null) return messages;

  if (typeof inputValue === "string") {
    messages.push({ role: "user", content: inputValue });
    return messages;
  }

  if (Array.isArray(inputValue)) {
    for (const item of inputValue) {
      if (typeof item === "string") {
        const txt = item.trim();
        if (txt) messages.push({ role: "user", content: txt });
        continue;
      }

      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const role =
        String(obj.role ?? "user")
          .trim()
          .toLowerCase() || "user";

      if ("content" in obj) {
        const contentText = contentBlocksToText(obj.content);
        if (contentText) messages.push({ role, content: contentText });
        continue;
      }

      if ("text" in obj) {
        const contentText = String(obj.text ?? "").trim();
        if (contentText) messages.push({ role, content: contentText });
      }
    }
    return messages;
  }

  messages.push({ role: "user", content: String(inputValue) });
  return messages;
}

export function normalizeIncomingMessages(kwargs: Record<string, unknown>): Message[] {
  const messages = kwargs.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    return messages as Message[];
  }

  const optionalParams = (kwargs.optional_params as Record<string, unknown>) ?? {};
  let inputValue = kwargs.input ?? optionalParams.input ?? null;
  let instructions =
    (kwargs.instructions as string) ?? (optionalParams.instructions as string) ?? undefined;

  return responsesInputToMessages(inputValue, instructions);
}

export function messagesToPrompt(messages: Message[], tools?: ToolDef[]): string {
  const systemParts: string[] = [];
  const convoParts: string[] = [];

  for (const msg of messages ?? []) {
    const role = String(msg.role ?? "user")
      .trim()
      .toLowerCase();
    const content = contentBlocksToText(msg.content);
    if (!content) continue;

    if (role === "system") {
      systemParts.push(content);
    } else if (role === "assistant") {
      convoParts.push(`Assistant: ${content}`);
    } else if (role === "tool") {
      const name = msg.name ?? "tool";
      convoParts.push(`Tool (${name}): ${content}`);
    } else {
      convoParts.push(`User: ${content}`);
    }
  }

  let toolNote = "";
  if (tools) {
    const toolNames: string[] = [];
    for (const tool of tools) {
      if (typeof tool !== "object" || tool === null) continue;
      if (String(tool.type ?? "").trim() === "function") {
        const name = tool.function?.name;
        if (name) toolNames.push(String(name));
      }
    }
    if (toolNames.length > 0) {
      toolNote =
        "\n\nClient tool hints:\n" +
        toolNames.join(", ") +
        "\nAct directly in the workspace when file or shell work is needed.";
    }
  }

  let base: string;
  if (systemParts.length > 0) {
    base = (
      "System instructions:\n" +
      systemParts.join("\n\n") +
      "\n\nConversation:\n" +
      convoParts.join("\n\n")
    ).trim();
  } else {
    base = convoParts.join("\n\n").trim();
  }

  return (
    base +
    toolNote +
    "\n\nImportant:" +
    "\n- Do the work directly in the workspace when the user asks to create, edit or run files." +
    "\n- Prefer non-interactive commands." +
    "\n- For scaffolders like Vite, always pass explicit path/name and template." +
    "\n- If the latest scaffolder is incompatible with the installed Node.js, use a compatible command instead of stopping." +
    "\n- Do not only describe a plan when you can execute the task."
  ).trim();
}

const UNIX_PATH_RE = /\/(?:[^\s'":<>|]+\/?)+/g;
const WIN_PATH_RE = /[A-Za-z]:\\(?:[^\\/:*?"<>|\s]+\\?)+/g;

export function extractExistingPathsFromText(text: string): string[] {
  const unixPaths = text.match(UNIX_PATH_RE) ?? [];
  const winPaths = text.match(WIN_PATH_RE) ?? [];
  const candidates: string[] = [];

  for (const raw of [...unixPaths, ...winPaths]) {
    const cleaned = raw.replace(/[.,;:!?)"'\]]+$/, "");
    try {
      if (existsSync(cleaned)) {
        candidates.push(path.resolve(cleaned));
      }
    } catch {
      // ignore
    }
  }
  return candidates;
}

export function commonExistingParent(paths: string[]): string | null {
  if (!paths.length) return null;

  const normalized = paths.map((p) => {
    try {
      return statSync(p).isFile() ? path.dirname(p) : p;
    } catch {
      return p;
    }
  });

  if (normalized.length === 1) return normalized[0];

  try {
    // Find common prefix by splitting on separator
    const parts = normalized.map((p) => p.split(path.sep));
    const common: string[] = [];
    for (let i = 0; i < parts[0].length; i++) {
      const seg = parts[0][i];
      if (parts.every((p) => p[i] === seg)) {
        common.push(seg);
      } else {
        break;
      }
    }
    const commonPath = common.join(path.sep) || path.sep;
    if (existsSync(commonPath)) return commonPath;
  } catch {
    // ignore
  }

  for (const p of normalized) {
    if (existsSync(p)) return p;
  }

  return null;
}
