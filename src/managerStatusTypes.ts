export interface ManagerStatusInstanceDetail {
  sessionId: string;
  pid: number;
  workspaceFolders: string[];
  workspaceFile: string | null;
  host: string;
  port: number;
  lastSeen: number;
  lastSeenLocal: string;
  lastSeenAgeSec: number;
  startedAt: number;
  startedAtLocal: string;
  uptimeSec: number;
}

export interface ManagerStatusSessionTarget {
  sessionId: string;
  host: string;
  port: number;
}

export interface ManagerStatusSessionDetail {
  sessionId: string;
  resolveCwd: string;
  workspaceSetExplicitly: boolean;
  workspaceMatched: boolean;
  target: ManagerStatusSessionTarget | null;
  lastSeen: number;
  lastSeenLocal: string;
  lastSeenAgeSec: number;
  offlineSince: number | null;
  offlineSinceLocal: string | null;
  clientRootsSupported: boolean;
  clientRootsListChangedSupported: boolean;
  clientCapabilityFlags: Record<string, boolean>;
  clientCapabilityObjectKeys: Record<string, string[]>;
  clientCapabilities: Record<string, unknown>;
  pendingRootsRequestId: string | null;
  lastRootsSyncAt: number | null;
  lastRootsSyncAtLocal: string | null;
  lastRootsSyncReason: 'initialized' | 'list_changed' | null;
  lastRootsCount: number | null;
  lastRootsPreview: string[];
  lastRootsError: string | null;
}

export interface ManagerStatusRootsPolicy {
  mode: 'server-requests-client';
  triggerOnInitialized: boolean;
  triggerOnListChanged: boolean;
  source: 'client-capability-roots';
  logging: '/mcp/log';
}

export interface ManagerStatusPayload {
  ok: true;
  version: string;
  now: number;
  nowIso: string;
  nowLocal: string;
  instances: number;
  instanceDetails: ManagerStatusInstanceDetail[];
  sessions: number;
  sessionDetails: ManagerStatusSessionDetail[];
  rootsPolicy: ManagerStatusRootsPolicy;
  lastNonEmptyAt: number;
  lastNonEmptyAtIso: string;
  lastNonEmptyAtLocal: string;
  lastNonEmptyAgeSec: number;
  uptimeSec: number;
}

export interface ManagerStatusBuildInstanceRecord {
  sessionId: string;
  pid: number;
  workspaceFolders: string[];
  workspaceFile?: string;
  host: string;
  port: number;
  lastSeen: number;
  startedAt: number;
}

export interface ManagerStatusBuildSessionState {
  sessionId: string;
  resolveCwd: string;
  workspaceSetExplicitly: boolean;
  workspaceMatched: boolean;
  currentTarget?: ManagerStatusSessionTarget;
  offlineSince?: number;
  clientSupportsRoots: boolean;
  clientSupportsRootsListChanged: boolean;
  clientCapabilityFlags: Record<string, boolean>;
  clientCapabilityObjectKeys: Record<string, string[]>;
  clientCapabilities: Record<string, unknown>;
  pendingRootsRequestId?: string;
  lastRootsSyncAt?: number;
  lastRootsSyncReason?: 'initialized' | 'list_changed';
  lastRootsCount?: number;
  lastRootsPreview: string[];
  lastRootsError?: string;
  lastSeen: number;
}

export interface ManagerStatusBuildInput {
  now: number;
  version: string;
  aliveInstances: ManagerStatusBuildInstanceRecord[];
  sessions: ManagerStatusBuildSessionState[];
  rootsPolicy: ManagerStatusRootsPolicy;
  lastNonEmptyAt: number;
  startupTime: number;
}
