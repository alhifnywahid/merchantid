/** Minimal structured logger interface with a no-op default. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Console-backed logger that respects a minimum level threshold. */
export function createConsoleLogger(minLevel: LogLevel = "info"): Logger {
  const threshold = LEVEL_ORDER[minLevel];

  const emit =
    (level: LogLevel) =>
    (message: string, meta?: Record<string, unknown>): void => {
      if (LEVEL_ORDER[level] < threshold) return;
      const line = `[merchid] ${level.toUpperCase()} ${message}`;
      if (meta) {
        // eslint-disable-next-line no-console
        console[level === "debug" ? "log" : level](line, meta);
      } else {
        // eslint-disable-next-line no-console
        console[level === "debug" ? "log" : level](line);
      }
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}
