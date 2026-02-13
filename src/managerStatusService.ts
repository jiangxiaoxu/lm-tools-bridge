import type { ManagerStatusBuildInput, ManagerStatusPayload } from './managerStatusTypes';

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatLocalDateTime(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function cloneJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
      return {};
    }
    return cloned as Record<string, unknown>;
  } catch {
    return {};
  }
}

function cloneBooleanRecord(record: Record<string, boolean>): Record<string, boolean> {
  const cloned: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'boolean') {
      cloned[key] = value;
    }
  }
  return cloned;
}

function cloneStringArrayRecord(record: Record<string, string[]>): Record<string, string[]> {
  const cloned: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(record)) {
    cloned[key] = Array.isArray(value) ? [...value] : [];
  }
  return cloned;
}

export function buildManagerStatusPayload(input: ManagerStatusBuildInput): ManagerStatusPayload {
  const now = input.now;
  return {
    ok: true,
    version: input.version,
    now,
    nowIso: new Date(now).toISOString(),
    nowLocal: formatLocalDateTime(now),
    instances: input.aliveInstances.length,
    instanceDetails: input.aliveInstances.map((record) => ({
      sessionId: record.sessionId,
      pid: record.pid,
      workspaceFolders: record.workspaceFolders,
      workspaceFile: record.workspaceFile ?? null,
      host: record.host,
      port: record.port,
      lastSeen: record.lastSeen,
      lastSeenLocal: formatLocalDateTime(record.lastSeen),
      lastSeenAgeSec: Math.floor((now - record.lastSeen) / 1000),
      startedAt: record.startedAt,
      startedAtLocal: formatLocalDateTime(record.startedAt),
      uptimeSec: Math.floor((now - record.startedAt) / 1000),
    })),
    sessions: input.sessions.length,
    sessionDetails: input.sessions.map((session) => ({
      sessionId: session.sessionId,
      resolveCwd: session.resolveCwd,
      workspaceSetExplicitly: session.workspaceSetExplicitly,
      workspaceMatched: session.workspaceMatched,
      target: session.currentTarget
        ? {
          sessionId: session.currentTarget.sessionId,
          host: session.currentTarget.host,
          port: session.currentTarget.port,
        }
        : null,
      lastSeen: session.lastSeen,
      lastSeenLocal: formatLocalDateTime(session.lastSeen),
      lastSeenAgeSec: Math.floor((now - session.lastSeen) / 1000),
      offlineSince: session.offlineSince ?? null,
      offlineSinceLocal: session.offlineSince ? formatLocalDateTime(session.offlineSince) : null,
      clientRootsSupported: session.clientSupportsRoots,
      clientRootsListChangedSupported: session.clientSupportsRootsListChanged,
      clientCapabilityFlags: cloneBooleanRecord(session.clientCapabilityFlags),
      clientCapabilityObjectKeys: cloneStringArrayRecord(session.clientCapabilityObjectKeys),
      clientCapabilities: cloneJsonRecord(session.clientCapabilities),
      pendingRootsRequestId: session.pendingRootsRequestId ?? null,
      lastRootsSyncAt: session.lastRootsSyncAt ?? null,
      lastRootsSyncAtLocal: session.lastRootsSyncAt ? formatLocalDateTime(session.lastRootsSyncAt) : null,
      lastRootsSyncReason: session.lastRootsSyncReason ?? null,
      lastRootsCount: typeof session.lastRootsCount === 'number' ? session.lastRootsCount : null,
      lastRootsPreview: [...session.lastRootsPreview],
      lastRootsError: session.lastRootsError ?? null,
    })),
    rootsPolicy: input.rootsPolicy,
    lastNonEmptyAt: input.lastNonEmptyAt,
    lastNonEmptyAtIso: new Date(input.lastNonEmptyAt).toISOString(),
    lastNonEmptyAtLocal: formatLocalDateTime(input.lastNonEmptyAt),
    lastNonEmptyAgeSec: Math.floor((now - input.lastNonEmptyAt) / 1000),
    uptimeSec: Math.floor((now - input.startupTime) / 1000),
  };
}
