type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private readonly level: LogLevel;

  constructor(level: LogLevel) {
    this.level = level;
  }

  debug(message: string, ...args: unknown[]): void {
    this.log("debug", message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log("info", message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log("warn", message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log("error", message, ...args);
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (ORDER[level] < ORDER[this.level]) {
      return;
    }
    const timestamp = new Date().toISOString();
    const payload = args.length > 0 ? ` ${args.map(stringify).join(" ")}` : "";
    const line = `${timestamp} ${level.toUpperCase()} ${message}${payload}`;
    if (level === "error") {
      // Keep stderr for errors to make process supervision easier.
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  }
}

function stringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
