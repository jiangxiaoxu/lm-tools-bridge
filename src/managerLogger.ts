import * as fs from 'node:fs';

export interface ManagerLogger {
  append(message: string): void;
  getLines(): string[];
  getConfig(): { envKey: string; maxLines: number };
}

export function createManagerLogger(options?: {
  envKey?: string;
  maxLines?: number;
  appendFileSync?: (path: string, data: string) => void;
  getEnv?: (key: string) => string | undefined;
  nowIso?: () => string;
}): ManagerLogger {
  const envKey = options?.envKey ?? 'LM_TOOLS_BRIDGE_MANAGER_LOG';
  const maxLines = options?.maxLines ?? 200;
  const appendFileSync = options?.appendFileSync ?? ((pathValue: string, data: string) => {
    fs.appendFileSync(pathValue, data, { encoding: 'utf8' });
  });
  const getEnv = options?.getEnv ?? ((key: string) => process.env[key]);
  const nowIso = options?.nowIso ?? (() => new Date().toISOString());
  const lines: string[] = [];

  function format(message: string): string {
    return `[${nowIso()}] ${message}`;
  }

  return {
    append(message: string): void {
      const line = format(message);
      lines.push(line);
      if (lines.length > maxLines) {
        lines.splice(0, lines.length - maxLines);
      }
      const logPath = getEnv(envKey);
      if (!logPath) {
        return;
      }
      try {
        appendFileSync(logPath, `${line}\n`);
      } catch {
        // Ignore log failures.
      }
    },
    getLines(): string[] {
      return [...lines];
    },
    getConfig(): { envKey: string; maxLines: number } {
      return { envKey, maxLines };
    },
  };
}
