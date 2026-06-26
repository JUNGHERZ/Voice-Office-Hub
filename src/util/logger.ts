/**
 * Minimaler strukturierter Logger (JSON-Lines auf stdout/stderr).
 * Bewusst dependency-frei; kann später durch pino o.ä. ersetzt werden.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function make(bindings: Record<string, unknown>): Logger {
  return {
    debug: (msg, meta) => emit("debug", msg, { ...bindings, ...meta }),
    info: (msg, meta) => emit("info", msg, { ...bindings, ...meta }),
    warn: (msg, meta) => emit("warn", msg, { ...bindings, ...meta }),
    error: (msg, meta) => emit("error", msg, { ...bindings, ...meta }),
    child: (extra) => make({ ...bindings, ...extra }),
  };
}

export const logger = make({});
