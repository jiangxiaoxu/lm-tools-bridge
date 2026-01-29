import * as http from 'node:http';
import * as path from 'node:path';
import { getManagerPipeName } from './managerShared';

interface InstanceRecord {
  sessionId: string;
  pid: number;
  workspaceFolders: string[];
  workspaceFile?: string;
  host: string;
  port: number;
  lastSeen: number;
  startedAt: number;
  normalizedFolders: string[];
  normalizedWorkspaceFile?: string;
}

const TTL_MS = 4000;
const PRUNE_INTERVAL_MS = 1000;
const IDLE_GRACE_MS = 10000;

const instances = new Map<string, InstanceRecord>();
let lastNonEmptyAt = Date.now();

function getPipeNameFromArgs(): string | undefined {
  const index = process.argv.indexOf('--pipe');
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return undefined;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').toLowerCase();
}

function normalizeFolders(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => normalizePath(entry));
}

function respondJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      reject(error);
    });
  });
}

function pickBestMatch(cwd: string, records: InstanceRecord[]): InstanceRecord | undefined {
  const normalizedCwd = normalizePath(cwd);
  let best: InstanceRecord | undefined;
  let bestScore = 0;

  for (const record of records) {
    let score = 0;
    if (record.normalizedWorkspaceFile && normalizedCwd === record.normalizedWorkspaceFile) {
      score = 3;
    } else if (record.normalizedFolders.includes(normalizedCwd)) {
      score = 2;
    } else if (record.normalizedFolders.some((folder) => normalizedCwd.startsWith(`${folder}\\`))) {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = record;
    } else if (score === bestScore && score > 0 && best && record.lastSeen > best.lastSeen) {
      best = record;
    }
  }

  return bestScore > 0 ? best : undefined;
}

function getAliveRecords(): InstanceRecord[] {
  const now = Date.now();
  const alive: InstanceRecord[] = [];
  for (const record of instances.values()) {
    if (now - record.lastSeen <= TTL_MS) {
      alive.push(record);
    }
  }
  return alive;
}

function pruneInstances(): void {
  const now = Date.now();
  for (const [key, record] of instances.entries()) {
    if (now - record.lastSeen > TTL_MS) {
      instances.delete(key);
    }
  }

  if (instances.size > 0) {
    lastNonEmptyAt = now;
    return;
  }

  if (now - lastNonEmptyAt >= IDLE_GRACE_MS) {
    shutdown();
  }
}

function shutdown(): void {
  server.close(() => {
    process.exit(0);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    respondJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url === '/list') {
    respondJson(res, 200, { ok: true, instances: getAliveRecords() });
    return;
  }

  if (req.method === 'POST' && url === '/heartbeat') {
    try {
      const payload = await readJsonBody(req);
      const record = payload as Partial<InstanceRecord>;
      if (!record.sessionId || !record.host || !record.port) {
        respondJson(res, 400, { ok: false, reason: 'invalid_payload' });
        return;
      }

      const now = Date.now();
      const workspaceFolders = Array.isArray(record.workspaceFolders) ? record.workspaceFolders : [];
      const normalizedFolders = normalizeFolders(workspaceFolders);
      const normalizedWorkspaceFile = record.workspaceFile ? normalizePath(record.workspaceFile) : undefined;

      const existing = instances.get(record.sessionId);
      instances.set(record.sessionId, {
        sessionId: record.sessionId,
        pid: record.pid ?? existing?.pid ?? 0,
        workspaceFolders,
        workspaceFile: record.workspaceFile ?? existing?.workspaceFile,
        host: record.host,
        port: record.port,
        lastSeen: now,
        startedAt: existing?.startedAt ?? now,
        normalizedFolders,
        normalizedWorkspaceFile,
      });

      lastNonEmptyAt = now;
      respondJson(res, 200, { ok: true });
      return;
    } catch {
      respondJson(res, 400, { ok: false, reason: 'invalid_json' });
      return;
    }
  }

  if (req.method === 'POST' && url === '/bye') {
    try {
      const payload = await readJsonBody(req);
      const sessionId = (payload as { sessionId?: string } | undefined)?.sessionId;
      if (sessionId) {
        instances.delete(sessionId);
      }
      respondJson(res, 200, { ok: true });
      return;
    } catch {
      respondJson(res, 400, { ok: false, reason: 'invalid_json' });
      return;
    }
  }

  if (req.method === 'POST' && url === '/resolve') {
    try {
      const payload = await readJsonBody(req);
      const cwd = (payload as { cwd?: string } | undefined)?.cwd;
      if (!cwd) {
        respondJson(res, 400, { ok: false, reason: 'missing_cwd' });
        return;
      }

      const alive = getAliveRecords();
      const match = pickBestMatch(cwd, alive);
      if (!match) {
        respondJson(res, 404, { ok: false, reason: 'not_found' });
        return;
      }

      respondJson(res, 200, {
        ok: true,
        match: {
          sessionId: match.sessionId,
          host: match.host,
          port: match.port,
          workspaceFolders: match.workspaceFolders,
          workspaceFile: match.workspaceFile ?? null,
        },
      });
      return;
    } catch {
      respondJson(res, 400, { ok: false, reason: 'invalid_json' });
      return;
    }
  }

  respondJson(res, 404, { ok: false, reason: 'not_found' });
});

server.on('error', (error) => {
  const err = error as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') {
    process.exit(0);
    return;
  }
  process.exit(1);
});

const pipeName = getPipeNameFromArgs() ?? getManagerPipeName();
server.listen(pipeName, () => {
  lastNonEmptyAt = Date.now();
});

const pruneTimer = setInterval(pruneInstances, PRUNE_INTERVAL_MS);
pruneTimer.unref();
