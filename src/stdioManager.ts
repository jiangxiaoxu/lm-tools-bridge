import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  formatWorkspaceHandshakeSummary,
  type WorkspaceHandshakePayload,
} from './managerHandshake';
import {
  getPathScopeSpecResourceDescription,
  getPathScopeSpecText,
  PATH_SCOPE_SPEC_URI,
} from './pathScopeSpec';
import { isSupportedWindowsWorkspacePath } from './windowsWorkspacePath';

const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.bindWorkspace';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callBridgedTool';
const GUIDE_RESOURCE_URI = 'lm-tools://guide';
const TOOL_NAMES_RESOURCE_URI = 'lm-tools://tool-names';
const TOOL_URI_TEMPLATE = 'lm-tools://tool/{name}';
const RUNTIME_MODULE_FILENAME = 'stdioManagerRuntime.js';
const METADATA_FILENAME = 'metadata.json';
const MANAGER_REGISTRY_DIRNAME = 'managers';
const CONTROL_PIPE_PREFIX = 'lm-tools-bridge.manager-control.v1.';
const CONTROL_PROTOCOL_VERSION = 1;
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;

interface WorkspaceToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RuntimeFingerprint {
  mtimeMs: number;
  size: number;
}

interface StdioManagerSyncMetadata {
  generation: number;
  extensionVersion: string;
  managerFileName: string;
  runtimeFileName: string;
  managerSha256: string;
  runtimeSha256: string;
  syncedAt: string;
}

interface StdioManagerRegistryEntry {
  protocolVersion: 1;
  sessionId: string;
  pid: number;
  startedAt: number;
  controlPipePath: string;
}

interface StdioManagerControlRequest {
  op: 'generationChanged';
  protocolVersion: 1;
  generation: number;
}

interface StdioManagerControlResponse {
  ok: true;
  protocolVersion: 1;
  generationApplied: number;
  bindingInvalidated: boolean;
}

interface StdioManagerRuntimeLocalHelperOverrides {
  guideText?: string;
  pathScopeText?: string;
  helperToolDefinitions?: WorkspaceToolDefinition[];
  toolTemplateDescription?: string;
}

interface StdioManagerRuntimeApi {
  bindWorkspace(server: Server, cwd: unknown): Promise<WorkspaceHandshakePayload>;
  callBridgedTool(server: Server, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listBridgedTools(): WorkspaceToolDefinition[];
  readBridgedResource(server: Server, uri: string): Promise<Record<string, unknown>>;
  invalidateBinding(server: Server): Promise<void>;
  getLocalHelperOverrides(): StdioManagerRuntimeLocalHelperOverrides;
  dispose(): Promise<void> | void;
}

interface RuntimeModuleShape {
  createStdioManagerRuntime: () => StdioManagerRuntimeApi;
}

class RuntimeController {
  private readonly runtimePath: string;

  private readonly metadataPath: string;

  private runtime?: StdioManagerRuntimeApi;

  private runtimeLoadError: unknown;

  private metadataFingerprint?: RuntimeFingerprint;

  private loadedGeneration = 0;

  private desiredGeneration = 0;

  private runtimeEpoch = 0;

  private refreshPromise?: Promise<void>;

  private generationTransitionTail: Promise<void> = Promise.resolve();

  private visibilityNotificationTail: Promise<void> = Promise.resolve();

  private bindingState: 'never-bound' | 'bound' | 'stale' = 'never-bound';

  public constructor(runtimePath: string, metadataPath: string) {
    this.runtimePath = runtimePath;
    this.metadataPath = metadataPath;
    const metadataState = readMetadataStateSync(this.metadataPath);
    this.metadataFingerprint = metadataState.fingerprint;
    if (metadataState.warning) {
      process.stderr.write(`${metadataState.warning}\n`);
    }
    if (metadataState.metadata) {
      this.desiredGeneration = metadataState.metadata.generation;
    }
    this.loadRuntimeForStartup();
  }

  public async ensureCurrent(server: Server): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshInternal(server);
    }
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  public getHelperOverrides(): StdioManagerRuntimeLocalHelperOverrides {
    return this.runtime?.getLocalHelperOverrides() ?? {};
  }

  public getVisibleBridgedTools(): WorkspaceToolDefinition[] {
    return this.runtime?.listBridgedTools() ?? [];
  }

  public async bindWorkspace(server: Server, cwd: unknown): Promise<WorkspaceHandshakePayload> {
    this.validateBindWorkspaceParams(cwd);
    await this.ensureCurrent(server);
    const runtime = this.requireRuntimeForBind();
    const runtimeEpoch = this.runtimeEpoch;
    const payload = await runtime.bindWorkspace(server, cwd);
    if (this.runtime !== runtime || this.runtimeEpoch !== runtimeEpoch) {
      throw new McpError(ErrorCode.InvalidRequest, getWorkspaceNotMatchedMessage());
    }
    this.bindingState = 'bound';
    return payload;
  }

  public async callBridgedTool(
    server: Server,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.ensureCurrent(server);
    if (this.bindingState === 'stale') {
      throw this.getStaleBridgedRequestError('tool-call');
    }
    const runtime = this.requireRuntimeForBridgedRequest('tool-call');
    const runtimeEpoch = this.runtimeEpoch;
    try {
      const result = await runtime.callBridgedTool(server, name, args);
      this.assertStableBridgedRequest(runtime, runtimeEpoch, 'tool-call');
      return result;
    } catch (error) {
      this.rethrowIfStaleBridgedRequest(runtime, runtimeEpoch, 'tool-call');
      throw error;
    }
  }

  public async readBridgedResource(server: Server, uri: string): Promise<Record<string, unknown>> {
    await this.ensureCurrent(server);
    if (this.bindingState === 'stale') {
      throw this.getStaleBridgedRequestError('resource-read');
    }
    const runtime = this.requireRuntimeForBridgedRequest('resource-read');
    const runtimeEpoch = this.runtimeEpoch;
    try {
      const result = await runtime.readBridgedResource(server, uri);
      this.assertStableBridgedRequest(runtime, runtimeEpoch, 'resource-read');
      return result;
    } catch (error) {
      this.rethrowIfStaleBridgedRequest(runtime, runtimeEpoch, 'resource-read');
      throw error;
    }
  }

  public async handleGenerationChanged(
    server: Server,
    generation: number,
  ): Promise<StdioManagerControlResponse> {
    const result = await this.applyGeneration(server, generation, 'control notification');
    return {
      ok: true,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      generationApplied: result.generationApplied,
      bindingInvalidated: result.bindingInvalidated,
    };
  }

  private loadRuntimeForStartup(): void {
    try {
      this.setRuntime(this.loadRuntimeModule());
      this.runtimeLoadError = undefined;
      this.loadedGeneration = this.desiredGeneration;
    } catch (error) {
      this.setRuntime(undefined);
      this.runtimeLoadError = error;
      process.stderr.write(`stdio manager runtime load failed: ${formatErrorMessage(error)}\n`);
    }
  }

  private loadRuntimeModule(): StdioManagerRuntimeApi {
    const modulePath = require.resolve(this.runtimePath);
    delete require.cache[modulePath];
    const loaded = require(modulePath) as Partial<RuntimeModuleShape>;
    if (typeof loaded.createStdioManagerRuntime !== 'function') {
      throw new Error(`Missing createStdioManagerRuntime export in '${this.runtimePath}'.`);
    }
    return loaded.createStdioManagerRuntime();
  }

  private async refreshInternal(server: Server): Promise<void> {
    const nextState = await readMetadataState(this.metadataPath);
    const fingerprintChanged = !fingerprintsEqual(this.metadataFingerprint, nextState.fingerprint);
    if (fingerprintChanged) {
      this.metadataFingerprint = nextState.fingerprint;
      if (nextState.warning) {
        process.stderr.write(`${nextState.warning}\n`);
      }
      if (nextState.metadata && nextState.metadata.generation > this.desiredGeneration) {
        this.desiredGeneration = nextState.metadata.generation;
      }
    } else if (nextState.metadata && nextState.metadata.generation > this.desiredGeneration) {
      this.desiredGeneration = nextState.metadata.generation;
    }
    if (this.desiredGeneration > this.loadedGeneration) {
      await this.applyGeneration(
        server,
        this.desiredGeneration,
        fingerprintChanged ? 'metadata refresh' : 'generation retry',
      );
    }
  }

  private async applyGeneration(
    server: Server,
    nextGeneration: number,
    reason: string,
  ): Promise<{ bindingInvalidated: boolean; generationApplied: number }> {
    return await this.enqueueGenerationTransition(async () => {
      if (!Number.isInteger(nextGeneration) || nextGeneration <= 0) {
        return {
          bindingInvalidated: false,
          generationApplied: this.loadedGeneration,
        };
      }
      if (nextGeneration > this.desiredGeneration) {
        this.desiredGeneration = nextGeneration;
      }
      const targetGeneration = this.desiredGeneration;
      if (this.runtime && this.loadedGeneration >= targetGeneration) {
        return {
          bindingInvalidated: false,
          generationApplied: this.loadedGeneration,
        };
      }

      const previousRuntime = this.runtime;
      let nextRuntime: StdioManagerRuntimeApi;
      try {
        nextRuntime = this.loadRuntimeModule();
      } catch (error) {
        this.runtimeLoadError = error;
        process.stderr.write(
          `stdio manager runtime load failed for generation ${String(targetGeneration)}: ${formatErrorMessage(error)}\n`,
        );
        return {
          bindingInvalidated: false,
          generationApplied: this.loadedGeneration,
        };
      }

      let bindingInvalidated = false;
      if (previousRuntime) {
        try {
          await previousRuntime.invalidateBinding(server);
          bindingInvalidated = this.bindingState === 'bound' || previousRuntime.listBridgedTools().length > 0;
        } catch (error) {
          process.stderr.write(`stdio manager runtime invalidate failed: ${formatErrorMessage(error)}\n`);
        }
      }
      if (bindingInvalidated || this.bindingState === 'bound') {
        this.bindingState = 'stale';
      }

      this.setRuntime(nextRuntime);
      this.runtimeLoadError = undefined;
      this.loadedGeneration = targetGeneration;
      process.stderr.write(
        `stdio manager runtime switched to generation ${String(targetGeneration)} (${reason}).\n`,
      );
      if (previousRuntime) {
        await disposeRuntime(previousRuntime);
      }

      this.queueVisibilityNotifications(server);
      return {
        bindingInvalidated,
        generationApplied: this.loadedGeneration,
      };
    });
  }

  private requireRuntimeForBind(): StdioManagerRuntimeApi {
    if (this.runtime) {
      return this.runtime;
    }
    throw new McpError(ErrorCode.InternalError, buildRuntimeUnavailableMessage(this.runtimeLoadError));
  }

  private requireRuntimeForBridgedRequest(kind: 'tool-call' | 'resource-read'): StdioManagerRuntimeApi {
    if (this.runtime) {
      return this.runtime;
    }
    if (kind === 'resource-read') {
      throw new McpError(
        ErrorCode.InvalidRequest,
        this.bindingState === 'stale'
          ? getBridgedResourceRebindMessage()
          : getBridgedResourceBindingRequiredMessage(),
      );
    }
    throw new McpError(
      ErrorCode.InvalidRequest,
      this.bindingState === 'stale'
        ? getWorkspaceNotMatchedMessage()
        : getWorkspaceNotSetMessage(),
    );
  }

  private assertStableBridgedRequest(
    runtime: StdioManagerRuntimeApi,
    runtimeEpoch: number,
    kind: 'tool-call' | 'resource-read',
  ): void {
    this.rethrowIfStaleBridgedRequest(runtime, runtimeEpoch, kind);
  }

  private rethrowIfStaleBridgedRequest(
    runtime: StdioManagerRuntimeApi,
    runtimeEpoch: number,
    kind: 'tool-call' | 'resource-read',
  ): void {
    if (this.runtime !== runtime || this.runtimeEpoch !== runtimeEpoch) {
      throw this.getStaleBridgedRequestError(kind);
    }
  }

  private getStaleBridgedRequestError(kind: 'tool-call' | 'resource-read'): McpError {
    return new McpError(
      ErrorCode.InvalidRequest,
      kind === 'resource-read'
        ? getBridgedResourceRebindMessage()
        : getWorkspaceNotMatchedMessage(),
    );
  }

  private validateBindWorkspaceParams(cwd: unknown): void {
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      throw new McpError(ErrorCode.InvalidParams, getInvalidRequestWorkspaceParamsMessage());
    }
    if (process.platform === 'win32' && !isSupportedWindowsWorkspacePath(cwd.trim())) {
      throw new McpError(ErrorCode.InvalidParams, getInvalidWindowsCwdMessage());
    }
  }

  private setRuntime(runtime: StdioManagerRuntimeApi | undefined): void {
    this.runtime = runtime;
    this.runtimeEpoch += 1;
  }

  private async enqueueGenerationTransition<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.generationTransitionTail.then(operation, operation);
    this.generationTransitionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  private queueVisibilityNotifications(server: Server): void {
    const runNotifications = async () => {
      try {
        await server.sendToolListChanged();
      } catch (error) {
        process.stderr.write(`stdio manager tool list changed notification failed: ${formatErrorMessage(error)}\n`);
      }
      try {
        await server.sendResourceListChanged();
      } catch (error) {
        process.stderr.write(`stdio manager resource list changed notification failed: ${formatErrorMessage(error)}\n`);
      }
    };
    this.visibilityNotificationTail = this.visibilityNotificationTail.then(
      runNotifications,
      runNotifications,
    );
  }
}

function buildStructuredToolResult(payload: unknown, text: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

function readRuntimeFingerprintSync(filePath: string): RuntimeFingerprint | undefined {
  try {
    const stats = fs.statSync(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return undefined;
  }
}

async function readRuntimeFingerprint(filePath: string): Promise<RuntimeFingerprint | undefined> {
  try {
    const stats = await fs.promises.stat(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return undefined;
  }
}

function fingerprintsEqual(
  left: RuntimeFingerprint | undefined,
  right: RuntimeFingerprint | undefined,
): boolean {
  return left?.mtimeMs === right?.mtimeMs && left?.size === right?.size;
}

function isValidMetadata(value: unknown): value is StdioManagerSyncMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Partial<StdioManagerSyncMetadata>;
  return typeof metadata.generation === 'number'
    && Number.isInteger(metadata.generation)
    && metadata.generation > 0
    && typeof metadata.extensionVersion === 'string'
    && typeof metadata.managerFileName === 'string'
    && typeof metadata.runtimeFileName === 'string'
    && typeof metadata.managerSha256 === 'string'
    && metadata.managerSha256.length > 0
    && typeof metadata.runtimeSha256 === 'string'
    && metadata.runtimeSha256.length > 0
    && typeof metadata.syncedAt === 'string'
    && metadata.syncedAt.trim().length > 0;
}

async function readMetadataState(metadataPath: string): Promise<{
  fingerprint?: RuntimeFingerprint;
  metadata?: StdioManagerSyncMetadata;
  warning?: string;
}> {
  const fingerprint = await readRuntimeFingerprint(metadataPath);
  if (!fingerprint) {
    return {};
  }
  try {
    const text = await fs.promises.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!isValidMetadata(parsed)) {
      return {
        fingerprint,
        warning: `stdio manager metadata ignored because '${metadataPath}' is invalid.`,
      };
    }
    return {
      fingerprint,
      metadata: parsed,
    };
  } catch (error) {
    return {
      fingerprint,
      warning: `stdio manager metadata ignored because '${metadataPath}' could not be read (${formatErrorMessage(error)}).`,
    };
  }
}

function readMetadataStateSync(metadataPath: string): {
  fingerprint?: RuntimeFingerprint;
  metadata?: StdioManagerSyncMetadata;
  warning?: string;
} {
  const fingerprint = readRuntimeFingerprintSync(metadataPath);
  if (!fingerprint) {
    return {};
  }
  try {
    const text = fs.readFileSync(metadataPath, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!isValidMetadata(parsed)) {
      return {
        fingerprint,
        warning: `stdio manager metadata ignored because '${metadataPath}' is invalid.`,
      };
    }
    return {
      fingerprint,
      metadata: parsed,
    };
  } catch (error) {
    return {
      fingerprint,
      warning: `stdio manager metadata ignored because '${metadataPath}' could not be read (${formatErrorMessage(error)}).`,
    };
  }
}

function getToolNameFromUri(uri: string, prefix: string): string | undefined {
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const raw = uri.slice(prefix.length);
  return raw.length > 0 ? decodeURIComponent(raw) : undefined;
}

function resourceJson(uri: string, payload: unknown, mimeType = 'application/json') {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    contents: [
      {
        uri,
        mimeType,
        text,
      },
    ],
  };
}

function buildToolInfoPayload(tool: WorkspaceToolDefinition): Record<string, unknown> {
  return {
    ...tool,
  };
}

function getRequestWorkspaceToolDescription(): string {
  return 'If the task calls for vscode-tools-like workspace search, code navigation, diagnostics, or VS Code IDE actions, or explicitly includes phrases like `vscode-tools` or `use vscode`, start here. Read lm-tools://guide before first use. Then bind this session to the workspace resolved from an absolute project path or absolute .code-workspace path, and rebind only when the workspace target changes. Input: { cwd: string }.';
}

function getDirectToolCallDescription(): string {
  return 'Read lm-tools://guide before first use. Then call a bridged workspace tool after bind, read lm-tools://tool/{name} before the first call, pass arguments that match the target tool inputSchema, and read lm-tools://spec/pathScope before any pathScope argument. Input: { name: string, arguments?: object }.';
}

function getRequestWorkspaceToolDefinition(): WorkspaceToolDefinition {
  return {
    name: REQUEST_WORKSPACE_METHOD,
    description: getRequestWorkspaceToolDescription(),
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Absolute workspace path to resolve. Use the absolute project root path or the absolute .code-workspace path. Relative paths are invalid.',
        },
      },
      required: ['cwd'],
    },
  };
}

function getDirectToolCallDefinition(): WorkspaceToolDefinition {
  return {
    name: DIRECT_TOOL_CALL_NAME,
    description: getDirectToolCallDescription(),
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Bridged tool name to call. Resolve it from discovery.bridgedTools, lm-tools://tool-names, or lm-tools://tool/{name}.',
        },
        arguments: {
          type: 'object',
          description: 'Optional arguments object for the bridged tool call. Must match the target tool inputSchema.',
        },
      },
      required: ['name'],
    },
  };
}

function getFallbackGuideText(): string {
  return [
    'Workspace bridge guide',
    '',
    'This MCP manager requires an explicit workspace binding before workspace tools can be used.',
    '',
    'When to bind:',
    `- Call ${REQUEST_WORKSPACE_METHOD} with params.cwd once per client session.`,
    '- Reuse the current bind across calls; do not handshake again before every tool call.',
    '- Re-run handshake only when the workspace target changes or the bound workspace goes offline.',
    '',
    'Core flow:',
    `1. Call ${REQUEST_WORKSPACE_METHOD} with params.cwd set to the project path or .code-workspace path.`,
    '2. Treat the resolved workspace roots as the validated lmToolsBridge scope.',
    '3. Follow guidance.nextSteps from the handshake response.',
    '4. Use discovery.bridgedTools as names-only discovery and read lm-tools://tool/{name} only for the tools needed by the current task after bind.',
    '5. Read lm-tools://tool/{name} before the first tool call and build arguments that match its inputSchema.',
    '6. Read lm-tools://spec/pathScope before any pathScope argument.',
    `7. Invoke ${DIRECT_TOOL_CALL_NAME} only after handshake and tool-definition read, or call the bridged tools returned by tools/list after handshake.`,
    '',
    'Routing and fallback:',
    '- Prefer lmToolsBridge tools for workspace file search, text search, multi-file inspection, and VS Code IDE actions inside validated workspace roots.',
    '- Prefer qgrep search tools for repeated workspace text search when they are available.',
    '- In multi-root workspaces, use WorkspaceName/... only when narrowing to one root; otherwise keep cross-root scope.',
    '- Do not use lmToolsBridge tools for paths outside validated workspace roots.',
    '- Never perform silent fallback. Report the failing tool and reason before any non-lmToolsBridge fallback.',
    '- If discovery is partial or has issues, refresh tool visibility before assuming a tool is unavailable.',
    `- On workspace failures or MCP call failures, ${getRebindRetryHint()}`,
    '- After handshake, if discovery.partial=true or discovery.issues is non-empty, refresh available tools via tools/list.',
    '',
    'Handshake result:',
    '- A successful handshake response includes discovery data (callTool, bridgedTools, resourceTemplates).',
    '- discovery.bridgedTools returns names only; read lm-tools://tool/{name} for per-tool description and inputSchema.',
    '- Reading lm-tools://tool-names or bridged lm-tools://tool/{name} before bind returns an actionable bind-required error.',
    '',
    'Direct tool call after handshake:',
    `- ${DIRECT_TOOL_CALL_NAME} is used after a successful workspace binding.`,
    '- Before the first direct call, read lm-tools://tool/{name} before the first tool call and build arguments that match its inputSchema.',
    '- Build arguments from the tool inputSchema you just read.',
    '- If any argument is named pathScope, read lm-tools://spec/pathScope before any pathScope argument.',
    `- Call ${DIRECT_TOOL_CALL_NAME} with the bridged tool name and arguments object.`,
  ].join('\n');
}

function getFallbackGuideDescription(): string {
  return `Detailed bridge usage guide: bind once per session with ${REQUEST_WORKSPACE_METHOD}, then follow the bridged-tool, pathScope, routing, and fallback guidance in this resource.`;
}

function getFallbackToolTemplateDescription(): string {
  return `Read a bridged tool definition by name after bind and before the first call, then build arguments from its inputSchema. Before bind, call ${REQUEST_WORKSPACE_METHOD} first.`;
}

function appendNextStep(message: string, nextStep: string): string {
  const trimmed = message.trim();
  const suffix = trimmed.endsWith('.') ? '' : '.';
  return `${trimmed}${suffix} Next step: ${nextStep}`;
}

function getRebindRetryHint(): string {
  return `call ${REQUEST_WORKSPACE_METHOD} with params.cwd, wait for ok=true, then retry once.`;
}

function getWorkspaceNotSetMessage(): string {
  return appendNextStep(
    'Workspace not set.',
    `call ${REQUEST_WORKSPACE_METHOD} with params.cwd before using workspace tools, then retry once.`,
  );
}

function getWorkspaceNotMatchedMessage(): string {
  return appendNextStep(
    'Workspace not matched.',
    `call ${REQUEST_WORKSPACE_METHOD} with a cwd inside the target workspace, wait for success, then retry once.`,
  );
}

function getBridgedResourceBindingRequiredMessage(): string {
  return appendNextStep(
    'Workspace binding required before reading bridged discovery resources.',
    `call ${REQUEST_WORKSPACE_METHOD} with params.cwd, wait for ok=true, then retry once.`,
  );
}

function getBridgedResourceRebindMessage(): string {
  return appendNextStep(
    'Active workspace binding required before reading bridged discovery resources.',
    `${getRebindRetryHint()} Bridged discovery resources are available only after a successful bind.`,
  );
}

function getInvalidRequestWorkspaceParamsMessage(): string {
  return appendNextStep(
    'Invalid params: expected params.cwd (string).',
    `call ${REQUEST_WORKSPACE_METHOD} with a non-empty cwd string and retry.`,
  );
}

function getInvalidWindowsCwdMessage(): string {
  return appendNextStep(
    'Invalid params.cwd: on Windows, only normal absolute paths or \\\\?\\ + normal absolute paths are supported.',
    `pass a supported absolute path to ${REQUEST_WORKSPACE_METHOD} and retry.`,
  );
}

function getDirectCallNameParamMessage(): string {
  return appendNextStep(
    'Invalid params: expected arguments.name (string).',
    `call ${DIRECT_TOOL_CALL_NAME} with { name: string, arguments?: object } and set arguments.name to a bridged tool name.`,
  );
}

function getDirectCallArgumentsParamMessage(): string {
  return appendNextStep(
    'Invalid params: expected arguments.arguments (object).',
    `pass arguments.arguments as an object that matches the target tool inputSchema from ${TOOL_URI_TEMPLATE}.`,
  );
}

function getDirectCallForbiddenToolNameMessage(): string {
  return appendNextStep(
    'Invalid params: tool name is not allowed.',
    'set arguments.name to a bridged workspace tool from discovery.bridgedTools or tools/list.',
  );
}

function buildRuntimeUnavailableMessage(error: unknown): string {
  const reason = error ? ` (${formatErrorMessage(error)})` : '';
  return appendNextStep(
    `Runtime reload is unavailable${reason}`,
    `retry ${REQUEST_WORKSPACE_METHOD} once; if it still fails, reactivate the VS Code extension and retry.`,
  );
}

function getHelperToolDefinitions(overrides: StdioManagerRuntimeLocalHelperOverrides): WorkspaceToolDefinition[] {
  const fallbackDefinitions = [
    getRequestWorkspaceToolDefinition(),
    getDirectToolCallDefinition(),
  ];
  const overrideMap = new Map<string, WorkspaceToolDefinition>();
  for (const entry of overrides.helperToolDefinitions ?? []) {
    if (entry?.name && typeof entry.name === 'string') {
      overrideMap.set(entry.name, entry);
    }
  }
  return fallbackDefinitions.map((definition) => overrideMap.get(definition.name) ?? definition);
}

function getGuideText(overrides: StdioManagerRuntimeLocalHelperOverrides): string {
  return overrides.guideText ?? getFallbackGuideText();
}

function getPathScopeText(overrides: StdioManagerRuntimeLocalHelperOverrides): string {
  return overrides.pathScopeText ?? getPathScopeSpecText();
}

function buildControlPipePath(sessionId: string, platform: NodeJS.Platform = process.platform): string {
  const pipeName = `${CONTROL_PIPE_PREFIX}${sessionId}`;
  if (platform === 'win32') {
    return `\\\\.\\pipe\\${pipeName}`;
  }
  return path.join(os.tmpdir(), `${pipeName}.sock`);
}

async function removeUnixSocketIfNeeded(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') {
    return;
  }
  try {
    await fs.promises.unlink(socketPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }
}

function isGenerationChangedRequest(value: unknown): value is StdioManagerControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const request = value as Partial<StdioManagerControlRequest>;
  return request.op === 'generationChanged'
    && request.protocolVersion === CONTROL_PROTOCOL_VERSION
    && typeof request.generation === 'number'
    && Number.isInteger(request.generation)
    && request.generation > 0;
}

async function writeFileAtomically(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rm(targetPath, { force: true });
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function tryRemoveFileSync(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort cleanup only.
  }
}

function writeJsonLine(socket: net.Socket, payload: StdioManagerControlResponse): void {
  socket.end(`${JSON.stringify(payload)}\n`);
}

async function disposeRuntime(runtime: StdioManagerRuntimeApi): Promise<void> {
  try {
    await runtime.dispose();
  } catch (error) {
    process.stderr.write(`stdio manager runtime dispose failed: ${formatErrorMessage(error)}\n`);
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const text = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(text) as { version?: unknown } | undefined;
    return typeof parsed?.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function createServer(): { server: Server; cleanup: () => void } {
  const runtimeController = new RuntimeController(
    path.join(__dirname, RUNTIME_MODULE_FILENAME),
    path.join(__dirname, METADATA_FILENAME),
  );
  const shellSessionId = crypto.randomUUID();
  const controlPipePath = buildControlPipePath(shellSessionId);
  const registryDir = path.join(__dirname, MANAGER_REGISTRY_DIRNAME);
  const registryPath = path.join(registryDir, `${shellSessionId}.json`);

  const server = new Server(
    {
      name: 'lm-tools-bridge-stdio-manager',
      version: getPackageVersion(),
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          listChanged: true,
        },
      },
    },
  );

  const cleanup = (() => {
    let cleaned = false;
    const controlServer = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > MAX_CONTROL_MESSAGE_BYTES) {
          socket.destroy();
          return;
        }
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        if (!line) {
          socket.destroy();
          return;
        }
        void (async () => {
          try {
            const parsed = JSON.parse(line) as unknown;
            if (!isGenerationChangedRequest(parsed)) {
              socket.destroy();
              return;
            }
            const response = await runtimeController.handleGenerationChanged(server, parsed.generation);
            writeJsonLine(socket, response);
          } catch {
            socket.destroy();
          }
        })();
      });
    });

    const cleanupOnce = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      tryRemoveFileSync(registryPath);
      try {
        controlServer.close();
      } catch {
        // Ignore cleanup failures.
      }
      if (process.platform !== 'win32') {
        tryRemoveFileSync(controlPipePath);
      }
    };

    void (async () => {
      await removeUnixSocketIfNeeded(controlPipePath).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        controlServer.once('error', reject);
        controlServer.listen(controlPipePath, () => {
          controlServer.unref();
          resolve();
        });
      });
      await fs.promises.mkdir(registryDir, { recursive: true });
      const entry: StdioManagerRegistryEntry = {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        sessionId: shellSessionId,
        pid: process.pid,
        startedAt: Date.now(),
        controlPipePath,
      };
      await writeFileAtomically(registryPath, `${JSON.stringify(entry, null, 2)}\n`);
    })().catch((error) => {
      process.stderr.write(`stdio manager control pipe startup failed: ${formatErrorMessage(error)}\n`);
      cleanupOnce();
    });

    process.once('exit', cleanupOnce);
    process.once('SIGINT', () => {
      cleanupOnce();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      cleanupOnce();
      process.exit(0);
    });

    return cleanupOnce;
  })();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await runtimeController.ensureCurrent(server);
    return {
      tools: [
        ...getHelperToolDefinitions(runtimeController.getHelperOverrides()),
        ...runtimeController.getVisibleBridgedTools(),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const rawArgs = request.params.arguments;
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
      ? rawArgs as Record<string, unknown>
      : {};

    if (name === REQUEST_WORKSPACE_METHOD) {
      const payload = await runtimeController.bindWorkspace(server, args.cwd);
      return buildStructuredToolResult(payload, formatWorkspaceHandshakeSummary(payload));
    }

    if (name === DIRECT_TOOL_CALL_NAME) {
      const targetToolName = typeof args.name === 'string' ? args.name.trim() : '';
      if (!targetToolName) {
        throw new McpError(ErrorCode.InvalidParams, getDirectCallNameParamMessage());
      }
      if (targetToolName === DIRECT_TOOL_CALL_NAME || targetToolName === REQUEST_WORKSPACE_METHOD) {
        throw new McpError(ErrorCode.InvalidParams, getDirectCallForbiddenToolNameMessage());
      }
      const targetArgs = args.arguments;
      if (targetArgs !== undefined && (typeof targetArgs !== 'object' || targetArgs === null || Array.isArray(targetArgs))) {
        throw new McpError(ErrorCode.InvalidParams, getDirectCallArgumentsParamMessage());
      }
      return await runtimeController.callBridgedTool(
        server,
        targetToolName,
        (targetArgs as Record<string, unknown> | undefined) ?? {},
      );
    }

    await runtimeController.ensureCurrent(server);
    return await runtimeController.callBridgedTool(server, name, args);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    await runtimeController.ensureCurrent(server);
    return {
      resources: [
        {
          uri: GUIDE_RESOURCE_URI,
          name: 'Bridge usage guide',
          description: getFallbackGuideDescription(),
          mimeType: 'text/plain',
        },
        {
          uri: PATH_SCOPE_SPEC_URI,
          name: 'Shared pathScope syntax',
          description: getPathScopeSpecResourceDescription(),
          mimeType: 'text/plain',
        },
        {
          uri: TOOL_NAMES_RESOURCE_URI,
          name: 'Bridged tool names',
          description: `Read bridged tool names after bind. This is names-only discovery; read lm-tools://tool/{name} on demand for the full definition. Before bind, call ${REQUEST_WORKSPACE_METHOD} first.`,
          mimeType: 'application/json',
        },
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    await runtimeController.ensureCurrent(server);
    const overrides = runtimeController.getHelperOverrides();
    return {
      resourceTemplates: [
        {
          name: 'Tool URI template',
          uriTemplate: TOOL_URI_TEMPLATE,
          description: overrides.toolTemplateDescription ?? getFallbackToolTemplateDescription(),
          mimeType: 'application/json',
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    await runtimeController.ensureCurrent(server);
    const uri = request.params.uri;
    const overrides = runtimeController.getHelperOverrides();
    if (uri === GUIDE_RESOURCE_URI) {
      return resourceJson(uri, getGuideText(overrides), 'text/plain');
    }
    if (uri === PATH_SCOPE_SPEC_URI) {
      return resourceJson(uri, getPathScopeText(overrides), 'text/plain');
    }
    if (uri === TOOL_NAMES_RESOURCE_URI) {
      return await runtimeController.readBridgedResource(server, uri);
    }
    const toolName = getToolNameFromUri(uri, 'lm-tools://tool/');
    if (!toolName) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
    }
    const helperDefinition = getHelperToolDefinitions(overrides).find((entry) => entry.name === toolName);
    if (helperDefinition) {
      return resourceJson(uri, buildToolInfoPayload(helperDefinition));
    }
    return await runtimeController.readBridgedResource(server, uri);
  });

  return { server, cleanup };
}

async function main(): Promise<void> {
  const created = createServer();
  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    process.stderr.write(`stdio manager transport error: ${String(error)}\n`);
  };
  await created.server.connect(transport);
}

void main().catch((error) => {
  process.stderr.write(`stdio manager failed: ${formatErrorMessage(error)}\n`);
  process.exitCode = 1;
});
