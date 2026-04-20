export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  return "info";
}

let currentLevel = resolveLevel();

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] <= LEVELS[currentLevel];
}

export const log = {
  error(...args: unknown[]): void {
    if (shouldLog("error")) console.error(...args);
  },
  warn(...args: unknown[]): void {
    if (shouldLog("warn")) console.warn(...args);
  },
  info(...args: unknown[]): void {
    if (shouldLog("info")) console.log(...args);
  },
  debug(...args: unknown[]): void {
    if (shouldLog("debug")) console.log(...args);
  },
  /** Current effective log level. */
  get level(): LogLevel {
    return currentLevel;
  },
  /** Re-read LOG_LEVEL from the environment (useful for tests). */
  reload(): void {
    currentLevel = resolveLevel();
  },
};
