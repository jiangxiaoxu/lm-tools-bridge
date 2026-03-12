export interface HandshakeDiscoveryTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface HandshakeDiscoveryResourceTemplate {
  name: string;
  uriTemplate: string;
}

export type DiscoveryIssueLevel = 'error' | 'warning';
export type DiscoveryIssueCategory = 'tools/list' | 'schema';

export interface HandshakeDiscoveryIssue {
  level: DiscoveryIssueLevel;
  category: DiscoveryIssueCategory;
  code: string;
  message: string;
  toolName?: string;
  details?: string;
}

export interface HandshakeDiscoveryPayload {
  callTool: HandshakeDiscoveryTool;
  bridgedTools: HandshakeDiscoveryTool[];
  resourceTemplates: HandshakeDiscoveryResourceTemplate[];
  partial: boolean;
  issues: HandshakeDiscoveryIssue[];
}

export interface HandshakeGuidance {
  nextSteps: string[];
  recoveryOnError: string;
}

export interface WorkspaceHandshakeTarget {
  sessionId: string;
  host: string;
  port: number;
  workspaceFolders: string[];
  workspaceFile: string | null;
}

export interface WorkspaceHandshakePayload {
  ok: true;
  mcpSessionId: string;
  cwd: string;
  target: WorkspaceHandshakeTarget;
  discovery: HandshakeDiscoveryPayload;
  guidance: HandshakeGuidance;
}

interface BuildWorkspaceHandshakePayloadInput {
  mcpSessionId: string;
  cwd: string;
  target: WorkspaceHandshakeTarget;
  discovery: HandshakeDiscoveryPayload;
  guidance: HandshakeGuidance;
}

export function buildWorkspaceHandshakePayload(
  input: BuildWorkspaceHandshakePayloadInput,
): WorkspaceHandshakePayload {
  return {
    ok: true,
    mcpSessionId: input.mcpSessionId,
    cwd: input.cwd,
    target: input.target,
    discovery: input.discovery,
    guidance: input.guidance,
  };
}

export function formatWorkspaceHandshakeSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return JSON.stringify(payload);
  }
  const record = payload as Record<string, unknown>;
  const target = (record.target && typeof record.target === 'object' && !Array.isArray(record.target))
    ? record.target as Record<string, unknown>
    : undefined;
  const discovery = (record.discovery && typeof record.discovery === 'object' && !Array.isArray(record.discovery))
    ? record.discovery as Record<string, unknown>
    : undefined;
  const discoveryIssues = Array.isArray(discovery?.issues) ? discovery.issues : [];
  const workspaceFolders = Array.isArray(target?.workspaceFolders) ? target.workspaceFolders : [];
  const bridgedTools = Array.isArray(discovery?.bridgedTools) ? discovery.bridgedTools : [];
  const guidance = (record.guidance && typeof record.guidance === 'object' && !Array.isArray(record.guidance))
    ? record.guidance as Record<string, unknown>
    : undefined;
  const guidanceNextSteps = Array.isArray(guidance?.nextSteps)
    ? guidance.nextSteps.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const guidanceRecovery = typeof guidance?.recoveryOnError === 'string'
    ? guidance.recoveryOnError.trim()
    : '';
  const bridgedToolNames = bridgedTools
    .map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        return '';
      }
      const name = (tool as { name?: unknown }).name;
      return typeof name === 'string' ? name.trim() : '';
    })
    .filter((name) => name.length > 0);
  const lines: string[] = [
    'Workspace handshake summary',
    `ok: ${record.ok === true ? 'true' : 'false'}`,
    `cwd: ${typeof record.cwd === 'string' ? record.cwd : 'n/a'}`,
    `target: ${String(target?.host ?? 'n/a')}:${String(target?.port ?? 'n/a')}`,
    `workspaceFolders: ${workspaceFolders.length}`,
    `discovery.partial: ${discovery?.partial === true ? 'true' : 'false'}`,
    `bridgedTools: ${bridgedTools.length}`,
  ];
  lines.push('tools:');
  if (bridgedToolNames.length === 0) {
    lines.push('  (none)');
  } else {
    for (const toolName of bridgedToolNames) {
      lines.push(`  - ${toolName}`);
    }
  }
  if (discoveryIssues.length === 0) {
    lines.push('Issues: none');
  } else {
    lines.push('Issues:');
    for (const issue of discoveryIssues) {
      if (!issue || typeof issue !== 'object') {
        continue;
      }
      const issueRecord = issue as {
        level?: unknown;
        category?: unknown;
        code?: unknown;
        message?: unknown;
        toolName?: unknown;
        details?: unknown;
      };
      const level = typeof issueRecord.level === 'string' ? issueRecord.level : 'unknown';
      const category = typeof issueRecord.category === 'string' ? issueRecord.category : 'unknown';
      const code = typeof issueRecord.code === 'string' ? issueRecord.code : 'UNKNOWN';
      const message = typeof issueRecord.message === 'string' ? issueRecord.message : '';
      const toolName = typeof issueRecord.toolName === 'string' ? issueRecord.toolName.trim() : '';
      const details = typeof issueRecord.details === 'string' ? issueRecord.details.trim() : '';
      const toolSuffix = toolName.length > 0 ? `[${toolName}]` : '';
      lines.push(`- [${level}][${category}][${code}]${toolSuffix} ${message}`);
      if (details.length > 0) {
        lines.push(`  details: ${details}`);
      }
    }
  }
  lines.push('Guidance:');
  if (guidanceNextSteps.length === 0) {
    lines.push('  nextSteps: (none)');
  } else {
    lines.push('  nextSteps:');
    for (const nextStep of guidanceNextSteps) {
      lines.push(`  - ${nextStep}`);
    }
  }
  if (guidanceRecovery.length > 0) {
    lines.push(`  recoveryOnError: ${guidanceRecovery}`);
  }
  return lines.join('\n');
}
