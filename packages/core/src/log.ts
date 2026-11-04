/** Tiny structured logger: one JSON line per entry, so logs can be grepped and shipped later. */
export type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.TENFOLD_LOG_LEVEL as Level) ?? "info";

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < order[minLevel]) return;
  const line = JSON.stringify(
    { t: new Date().toISOString(), level, msg, ...fields },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => log("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => log("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => log("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => log("error", msg, f),
};
