import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import dotenv from "dotenv";

interface InitQuestion {
  key: string;
  label: string;
  required?: boolean;
  fallbackValue?: string;
  hiddenDefault?: boolean;
  validate?: (value: string) => string | null;
}

export interface InitCommandOptions {
  cwd?: string;
  force?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function runInitCommand(options: InitCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const envPath = path.resolve(cwd, ".env");
  const templatePath = path.resolve(cwd, ".env.example");
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Cannot find template file: ${templatePath}`);
  }

  const templateContent = fs.readFileSync(templatePath, "utf8");
  const existingContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const existingValues = existingContent ? dotenv.parse(existingContent) : {};

  const rl = createInterface({ input, output });
  try {
    if (existingContent && !options.force) {
      const overwrite = await askYesNo(
        rl,
        "Detected existing .env file. Overwrite with guided setup?",
        false,
      );
      if (!overwrite) {
        output.write("Init aborted. Keep existing .env unchanged.\n");
        return;
      }
    }

    output.write("CodeHarbor setup wizard\n");
    output.write(`Target file: ${envPath}\n`);

    const questions: InitQuestion[] = [
      {
        key: "MATRIX_HOMESERVER",
        label: "Matrix homeserver URL",
        required: true,
        validate: (value) => {
          try {
            new URL(value);
            return null;
          } catch {
            return "Please enter a valid URL, for example https://matrix.example.com";
          }
        },
      },
      {
        key: "MATRIX_USER_ID",
        label: "Matrix bot user id",
        required: true,
        validate: (value) => {
          if (!/^@[^:\s]+:.+/.test(value)) {
            return "Please enter a Matrix user id like @bot:example.com";
          }
          return null;
        },
      },
      {
        key: "MATRIX_ACCESS_TOKEN",
        label: "Matrix access token",
        required: true,
        hiddenDefault: true,
      },
      {
        key: "MATRIX_COMMAND_PREFIX",
        label: "Group command prefix",
        fallbackValue: "!code",
      },
      {
        key: "CODEX_BIN",
        label: "Codex binary",
        fallbackValue: "codex",
      },
      {
        key: "CODEX_WORKDIR",
        label: "Codex working directory",
        fallbackValue: cwd,
        validate: (value) => {
          const resolved = path.resolve(cwd, value);
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return `Directory does not exist: ${resolved}`;
          }
          return null;
        },
      },
    ];

    const updates: Record<string, string> = {};
    for (const question of questions) {
      const existingValue = (existingValues[question.key] ?? "").trim();
      const value = await askValue(rl, question, existingValue);
      updates[question.key] = value;
    }

    const mergedContent = applyEnvOverrides(templateContent, updates);
    fs.writeFileSync(envPath, mergedContent, "utf8");

    output.write(`Wrote ${envPath}\n`);
    output.write("Next steps:\n");
    output.write("1. codex login\n");
    output.write("2. codeharbor doctor\n");
    output.write("3. codeharbor start\n");
  } finally {
    rl.close();
  }
}

export function applyEnvOverrides(template: string, overrides: Record<string, string>): string {
  const lines = template.split(/\r?\n/);
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!(key in overrides)) {
      continue;
    }
    lines[i] = `${key}=${formatEnvValue(overrides[key] ?? "")}`;
    seen.add(key);
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (seen.has(key)) {
      continue;
    }
    lines.push(`${key}=${formatEnvValue(value)}`);
  }

  const content = lines.join("\n");
  return content.endsWith("\n") ? content : `${content}\n`;
}

function formatEnvValue(value: string): string {
  if (!value) {
    return "";
  }
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

async function askValue(
  rl: ReturnType<typeof createInterface>,
  question: InitQuestion,
  existingValue: string,
): Promise<string> {
  while (true) {
    const fallback = question.fallbackValue ?? "";
    const displayDefault = existingValue || fallback;
    const hint = displayDefault
      ? question.hiddenDefault
        ? "[already set]"
        : `[${displayDefault}]`
      : "";
    const answer = (await rl.question(`${question.label} ${hint}: `)).trim();
    const finalValue = answer || existingValue || fallback;

    if (question.required && !finalValue) {
      rl.write("This value is required.\n");
      continue;
    }

    if (question.validate) {
      const reason = question.validate(finalValue);
      if (reason) {
        rl.write(`${reason}\n`);
        continue;
      }
    }

    return finalValue;
  }
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const defaultHint = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${question} ${defaultHint}: `)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  return answer === "y" || answer === "yes";
}
