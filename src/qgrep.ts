import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  compileFilesQueryGlobToRegexSource,
  compileGlobToRegexSource,
  hasUnescapedGlobMeta,
  normalizeFilesQueryGlobErrorMessage,
  normalizeWorkspaceSearchGlobPattern,
} from './qgrepGlob';
import { retryQgrepClearRemoval } from './qgrepClear';
import {
  buildFilesQueryDraft,
  ensureFilesLegacyParamsUnsupported,
  type FilesQueryDraft,
  type QgrepFilesQuerySemantics,
} from './qgrepFilesQuery';
import { upsertWorkspaceConfigPathLine } from './qgrepConfig';
import {
  parseOptionalPathScope,
  parseQuerySyntax,
  type QgrepFilesQuerySyntax,
  type QgrepTextQuerySyntax,
} from './searchInput';
import { parseLiteralTextQuery } from './qgrepTextQuery';
import { tryResolveWorkspaceScopePattern } from './qgrepWorkspaceScope';
import {
  parseOptionalContextLineCount,
  type ParsedOptionalContextLineCount,
} from './qgrepOutput';
import {
  advanceQgrepRecoveryAfterRecoverableUpdateFailure,
  beginQgrepExplicitRecovery,
  createEmptyQgrepRecoveryState,
  finalizeSuccessfulQgrepIndexProgress,
  hasQueuedQgrepAutoUpdate,
  isQgrepRecoveryActive,
  isQgrepWorkspaceReadyForToolSearch,
  markQgrepRecoveryDegraded,
  type QgrepRecoveryPhase,
  resetQgrepRecoveryState,
  restoreQgrepAutoUpdateQueueAfterFailure,
  shouldRecoverStaleQgrepWatch,
} from './qgrepIndexingState';

const QGREP_DIR_NAME = 'qgrep';
const QGREP_CONFIG_FILE_NAME = 'workspace.cfg';
const WATCH_RESTART_DELAY_MS = 1000;
const WATCH_STALE_CHECK_INTERVAL_MS = 5_000;
const WATCH_STALE_PROGRESS_TIMEOUT_MS = 20_000;
const WATCH_STALE_MAX_RESTARTS = 1;
const CLEAR_PROCESS_EXIT_TIMEOUT_MS = 5000;
const AUTO_UPDATE_DEBOUNCE_MS = 2000;
const SEARCH_EXCLUDE_SYNC_DEBOUNCE_MS = 500;
const TOOL_SEARCH_READY_TIMEOUT_MS = 110_000;
const TOOL_SEARCH_READY_POLL_INTERVAL_MS = 200;
const QGREP_RECOVERY_WARNING_PREFIX = 'Qgrep automatic recovery exhausted';
const DEFAULT_MAX_RESULTS = 300;
const MIN_MAX_RESULTS = 1;
const QGREP_TEXT_MAX_RESULTS_LIMIT = 2000;
const QGREP_FILES_MAX_RESULTS_LIMIT = 2000;
const INIT_COMMAND_HINT = 'Run "LM Tools Bridge: Qgrep Init All Workspaces" first.';
const QGREP_PROGRESS_FRAME_PATTERN = /\[\s*(\d{1,3})%\]\s+(\d+)\s+files\b/u;
const QGREP_SUMMARY_PATTERN = /^Search complete,\s+found\s+(\d+)(\+)?\s+(?:matches?|files?)\s+in\b/iu;
const QGREP_MANAGED_SEARCH_EXCLUDE_BLOCK_BEGIN = '# BEGIN lm-tools-bridge managed search.exclude';
const QGREP_MANAGED_SEARCH_EXCLUDE_BLOCK_END = '# END lm-tools-bridge managed search.exclude';
const QGREP_MANAGED_SEARCH_EXCLUDE_SOURCE_COMMENT = '# source: VS Code search.exclude (true entries only)';
const QGREP_MANAGED_SEARCH_EXCLUDE_EMPTY_COMMENT = '# no eligible search.exclude=true patterns';
const QGREP_MANAGED_SHADER_INCLUDE_BLOCK_BEGIN = '# BEGIN lm-tools-bridge managed shader include';
const QGREP_MANAGED_SHADER_INCLUDE_BLOCK_END = '# END lm-tools-bridge managed shader include';
const QGREP_MANAGED_SHADER_INCLUDE_SOURCE_COMMENT =
  '# source: lm-tools-bridge Unreal Engine include set (*.ush, *.usf, *.ini, *.uplugin, *.uproject)';
const QGREP_MANAGED_SHADER_INCLUDE_RULE = '\\.(ush|usf|ini|uplugin|uproject)$';
const QGREP_MANAGED_POWERSHELL_INCLUDE_BLOCK_BEGIN = '# BEGIN lm-tools-bridge managed powershell include';
const QGREP_MANAGED_POWERSHELL_INCLUDE_BLOCK_END = '# END lm-tools-bridge managed powershell include';
const QGREP_MANAGED_POWERSHELL_INCLUDE_SOURCE_COMMENT = '# source: lm-tools-bridge PowerShell include set (*.ps1)';
const QGREP_MANAGED_POWERSHELL_INCLUDE_RULE = '\\.(ps1)$';
const QGREP_FIXED_EXCLUDE_REGEXES: readonly string[] = [
  '(^|.*/)\\.git/',
  '(^|.*/)Intermediate/',
  '(^|.*/)DerivedDataCache/',
  '(^|.*/)Saved/',
  '(^|.*/)\\.vs/',
  '(^|.*/)\\.vscode/',
];

type QgrepLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type QgrepStatusChangeHandler = () => void;

let qgrepLogger: QgrepLogger = {
  info: (message: string) => console.info(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};
let qgrepStatusChangeHandler: QgrepStatusChangeHandler | undefined;

export interface QgrepCommandSummary {
  totalWorkspaces: number;
  processed: number;
  failed: number;
  message: string;
  failures: string[];
}

export interface QgrepWorkspaceStatus {
  workspaceName: string;
  initialized: boolean;
  watching: boolean;
  ready: boolean;
  indexedFiles?: number;
  totalFiles?: number;
  remainingFiles?: number;
  progressPercent?: number;
  progressKnown: boolean;
  indexing: boolean;
  recoveryPhase?: QgrepRecoveryPhase;
  recoveryAttemptCount?: number;
  fallbackRebuildPending?: boolean;
  degraded?: boolean;
  lastRecoverableError?: string;
}

export interface QgrepStatusSummary {
  binaryPath: string;
  binaryAvailable: boolean;
  totalWorkspaces: number;
  initializedWorkspaces: number;
  watchingWorkspaces: number;
  workspaceStatuses: QgrepWorkspaceStatus[];
}

interface WorkspaceQgrepState {
  key: string;
  folder: vscode.WorkspaceFolder;
  qgrepDirPath: string;
  configPath: string;
  progress: WorkspaceIndexProgress;
  watchProcess?: ChildProcessWithoutNullStreams;
  restartTimer?: NodeJS.Timeout;
  fsWatcher?: vscode.FileSystemWatcher;
  autoUpdateTimer?: NodeJS.Timeout;
  autoUpdateInFlight: boolean;
  autoUpdateDirty: boolean;
  pendingCreateDeleteCount: number;
  pendingIndexOperationCount: number;
  managedSearchExcludeDirty: boolean;
  restartOnExit: boolean;
  indexOperationChain?: Promise<void>;
  toolEnsureReadyPromise?: Promise<void>;
  activeIndexCommandProcess?: ChildProcessWithoutNullStreams;
  activeIndexCommandKind?: QgrepIndexCommandKind;
  activeIndexCommandCancelledProcess?: ChildProcessWithoutNullStreams;
  startupRefreshPending: boolean;
  startupAutoRepairAttempted: boolean;
  recoveryPhase: QgrepRecoveryPhase;
  recoveryAttemptCount: number;
  lastRecoverableError?: string;
  warningShownForCurrentFailure: boolean;
  watchWasRunningBeforeRebuild: boolean;
  allowExplicitRecovery: boolean;
  lastProgressFrameAt?: number;
  staleWatchRestartCount: number;
  staleWatchRecoverySignature?: string;
}

interface WorkspaceIndexProgress {
  indexedFiles?: number;
  totalFiles?: number;
  remainingFiles?: number;
  progressPercent?: number;
  progressKnown: boolean;
  indexing: boolean;
}

interface QgrepCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface QgrepCommandOptions {
  progressState?: WorkspaceQgrepState;
}

type QgrepIndexCommandKind = 'init' | 'update' | 'build';

interface WorkspaceIndexCommandResult {
  command: QgrepCommandResult;
  cancelledByClear: boolean;
}

type IndexCommandLogScope = 'autoupdate' | 'init' | 'rebuild';

interface QgrepSearchTarget {
  state: WorkspaceQgrepState;
  filterRegex?: string;
}

interface QgrepGlobPathMatcher {
  pattern: string;
  pathRegexSource: string;
  regex: RegExp;
  matchTarget: 'relative' | 'absolute';
}

interface QgrepGlobSearchTarget {
  state: WorkspaceQgrepState;
  matcher: QgrepGlobPathMatcher;
  textFilterRegex: string;
}

interface ResolvedSearchPath {
  state: WorkspaceQgrepState;
  absolutePath: string;
}

interface ParsedQgrepMatch {
  absolutePath: string;
  line: number;
  preview: string;
}

interface ParsedQgrepResultSummary {
  totalMatches?: number;
  capped: boolean;
}

type QgrepTextQuerySemantics = 'literal' | 'literal-fallback' | 'regex';
type QgrepTextCasePolicy = 'smart-case' | 'explicit-case-sensitive';
interface ParsedQgrepFile {
  absolutePath: string;
}

interface WorkspaceSearchResult {
  matches: ParsedQgrepMatch[];
  limitApplied: number;
  totalAvailableCapped: boolean;
}

interface WorkspaceFilesResult {
  files: ParsedQgrepFile[];
  totalAvailableCapped: boolean;
}

interface FilesQueryTarget {
  state: WorkspaceQgrepState;
  queryRegex: string;
}

interface FilesQueryPlan {
  targets: FilesQueryTarget[];
  scope: string | null;
  semantics: QgrepFilesQuerySemantics;
}

interface MaxResultsPayload {
  maxResultsApplied: number;
  maxResultsRequested?: number;
}

export class QgrepUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QgrepUnavailableError';
  }
}

export function isQgrepUnavailableError(error: unknown): error is QgrepUnavailableError {
  return error instanceof QgrepUnavailableError
    || (
      typeof error === 'object'
      && error !== null
      && 'name' in error
      && (error as { name?: unknown }).name === 'QgrepUnavailableError'
    );
}

class QgrepService implements vscode.Disposable {
  private readonly states = new Map<string, WorkspaceQgrepState>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;
  private watchHealthTimer?: NodeJS.Timeout;

  constructor(private readonly binaryPath: string) {}

  public activate(): void {
    this.syncWorkspaceStates(vscode.workspace.workspaceFolders ?? []);
    this.startWatchForInitializedWorkspaces();
    this.startAutoUpdateWatchersForInitializedWorkspaces();
    this.startWatchHealthChecks();
    this.notifyStatusChanged();
    this.queueStartupRefreshForInitializedWorkspaces();

    const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      this.handleWorkspaceFolderChanges(event);
    });
    const searchExcludeWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
      this.handleSearchExcludeConfigurationChanges(event);
    });
    this.subscriptions.push(folderWatcher, searchExcludeWatcher);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const state of this.states.values()) {
      this.stopWatch(state);
      this.stopAutoUpdateWatcher(state);
      this.cancelWorkspaceIndexCommandForClear(state);
    }
    if (this.watchHealthTimer) {
      clearInterval(this.watchHealthTimer);
      this.watchHealthTimer = undefined;
    }
    this.states.clear();
    this.notifyStatusChanged();

    for (const disposable of this.subscriptions) {
      try {
        disposable.dispose();
      } catch {
        // Ignore dispose failures.
      }
    }
    this.subscriptions.length = 0;
  }

  public async initAllWorkspaces(): Promise<QgrepCommandSummary> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new Error('No workspace folders are open.');
    }
    this.syncWorkspaceStates(folders);

    const failures: string[] = [];
    let processed = 0;
    for (const folder of folders) {
      const state = this.getStateForFolder(folder);
      if (!state) {
        failures.push(`${folder.name}: failed to allocate workspace state.`);
        continue;
      }
      try {
        await this.initWorkspace(state);
        processed += 1;
      } catch (error) {
        failures.push(`${folder.name}: ${String(error)}`);
      }
    }

    const summary = this.buildSummary(
      folders.length,
      processed,
      failures,
      failures.length === 0
        ? `Qgrep initialized for ${processed}/${folders.length} workspace(s).`
        : `Qgrep initialized for ${processed}/${folders.length} workspace(s), ${failures.length} failed.`,
    );
    return summary;
  }

  public async rebuildAllWorkspaces(): Promise<QgrepCommandSummary> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new Error('No workspace folders are open.');
    }
    this.syncWorkspaceStates(folders);

    const failures: string[] = [];
    let processed = 0;
    for (const folder of folders) {
      const state = this.getStateForFolder(folder);
      if (!state) {
        failures.push(`${folder.name}: failed to allocate workspace state.`);
        continue;
      }
      try {
        await this.rebuildWorkspace(state);
        processed += 1;
      } catch (error) {
        failures.push(`${folder.name}: ${String(error)}`);
      }
    }

    const summary = this.buildSummary(
      folders.length,
      processed,
      failures,
      failures.length === 0
        ? `Qgrep indexes rebuilt for ${processed}/${folders.length} workspace(s).`
        : `Qgrep indexes rebuilt for ${processed}/${folders.length} workspace(s), ${failures.length} failed.`,
    );
    return summary;
  }

  public async stopAndClearAllWorkspaces(): Promise<QgrepCommandSummary> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new Error('No workspace folders are open.');
    }
    this.syncWorkspaceStates(folders);

    const failures: string[] = [];
    let processed = 0;
    for (const folder of folders) {
      const state = this.getStateForFolder(folder);
      if (!state) {
        failures.push(`${folder.name}: failed to allocate workspace state.`);
        continue;
      }
      try {
        const watchProcess = state.watchProcess;
        const activeIndexProcess = state.activeIndexCommandProcess;
        const activeIndexKind = state.activeIndexCommandKind ?? 'index';
        this.stopWatch(state);
        this.stopAutoUpdateWatcher(state);
        this.cancelWorkspaceIndexCommandForClear(state);
        await Promise.all([
          this.waitForChildProcessExitForClear(state, watchProcess, 'watch'),
          this.waitForChildProcessExitForClear(state, activeIndexProcess, activeIndexKind),
        ]);
        await this.removeWorkspaceIndexDirectoryForClear(state);
        this.resetWorkspaceProgress(state);
        this.resetWorkspaceRecovery(state);
        this.setWorkspaceIndexing(state, false);
        processed += 1;
      } catch (error) {
        failures.push(`${folder.name}: ${String(error)}`);
      }
    }

    const summary = this.buildSummary(
      folders.length,
      processed,
      failures,
      failures.length === 0
        ? `Qgrep index directory cleared for ${processed}/${folders.length} workspace(s).`
        : `Qgrep index directory cleared for ${processed}/${folders.length} workspace(s), ${failures.length} failed.`,
    );
    return summary;
  }

  public async search(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = this.parseQuery(input);
    const pathScope = parseOptionalPathScope(input);
    const querySyntax = this.parseTextQuerySyntax(input);
    const caseSensitive = this.parseOptionalBooleanInput(input.caseSensitive, 'caseSensitive');
    const beforeContextLines = parseOptionalContextLineCount(input.beforeContextLines, 'beforeContextLines');
    const afterContextLines = parseOptionalContextLineCount(input.afterContextLines, 'afterContextLines');
    const contextLinesPayload = this.buildContextLinePayload(beforeContextLines, afterContextLines);
    const parsedLiteralQuery = querySyntax === 'regex'
      ? undefined
      : parseLiteralTextQuery(query);
    const queryHints = parsedLiteralQuery?.queryHints ?? [];
    const querySemanticsApplied: QgrepTextQuerySemantics = querySyntax === 'regex'
      ? 'regex'
      : parsedLiteralQuery!.mode === 'fallback-literal'
        ? 'literal-fallback'
        : 'literal';
    const backendQuery = querySyntax === 'regex'
      ? query
      : parsedLiteralQuery!.regexSource;
    const casePolicy: QgrepTextCasePolicy = caseSensitive === true
      ? 'explicit-case-sensitive'
      : 'smart-case';
    const maxResults = this.parseMaxResults(input);
    const maxResultsPayload = this.buildSearchMaxResultsPayload(maxResults);
    const maxResultsApplied = maxResultsPayload.maxResultsApplied;
    const useCaseInsensitiveSearch = caseSensitive === true
      ? false
      : this.shouldUseCaseInsensitiveSearchForQuery(querySyntax, query, parsedLiteralQuery);
    await this.ensureToolSearchReady();
    if (pathScope && this.isGlobPathScope(pathScope)) {
      return this.searchWithGlobPathScope(
        pathScope,
        query,
        backendQuery,
        querySemanticsApplied,
        casePolicy,
        useCaseInsensitiveSearch,
        maxResultsPayload,
        queryHints,
        beforeContextLines,
        afterContextLines,
      );
    }

    const targets = this.resolveSearchTargets(pathScope);
    if (targets.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const matches: Array<Record<string, unknown>> = [];
    let totalAvailable = 0;
    let totalAvailableCapped = false;
    let hardLimitHit = false;

    for (const target of targets) {
      const targetResult = await this.searchInWorkspace(
        target,
        backendQuery,
        useCaseInsensitiveSearch,
        maxResultsApplied,
      );
      totalAvailable += targetResult.matches.length;
      totalAvailableCapped = totalAvailableCapped || targetResult.totalAvailableCapped;
      hardLimitHit = hardLimitHit
        || (targetResult.totalAvailableCapped && targetResult.limitApplied >= QGREP_TEXT_MAX_RESULTS_LIMIT);

      if (matches.length >= maxResultsApplied) {
        continue;
      }
      const remaining = maxResultsApplied - matches.length;
      const selectedMatches = targetResult.matches.slice(0, remaining);
      for (const match of selectedMatches) {
        matches.push(this.toMatchPayload(target.state.folder, match));
      }
    }

    const capped = totalAvailableCapped || matches.length < totalAvailable;

    return {
      query,
      pathScope: pathScope ?? null,
      ...maxResultsPayload,
      totalAvailable,
      ...(totalAvailableCapped ? { totalAvailableCapped: true } : {}),
      ...(hardLimitHit ? { hardLimitHit: true } : {}),
      count: matches.length,
      capped,
      querySemanticsApplied,
      casePolicy,
      caseModeApplied: useCaseInsensitiveSearch ? 'insensitive' : 'sensitive',
      ...(queryHints.length > 0 ? { queryHints: [...queryHints] } : {}),
      ...contextLinesPayload,
      matches,
    };
  }

  public async files(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = this.parseFilesQuery(input);
    const filesQueryDraft = this.buildFilesQueryDraft(input, query);
    const maxResults = this.parseMaxResults(input);
    const maxResultsPayload = this.buildFilesMaxResultsPayload(maxResults);
    const maxResultsApplied = maxResultsPayload.maxResultsApplied;
    await this.ensureToolSearchReady();
    const filesQueryPlan = this.materializeFilesQueryPlan(filesQueryDraft);

    if (filesQueryPlan.targets.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const files: Array<Record<string, unknown>> = [];
    let totalAvailable = 0;
    let totalAvailableCapped = false;
    let hardLimitHit = false;
    let remaining = maxResultsApplied;

    for (let index = 0; index < filesQueryPlan.targets.length; index += 1) {
      if (remaining <= 0) {
        totalAvailableCapped = true;
        break;
      }
      const target = filesQueryPlan.targets[index];
      const targetResult = await this.searchFilesInWorkspace(target.state, target.queryRegex, remaining);
      totalAvailable += targetResult.files.length;
      totalAvailableCapped = totalAvailableCapped || targetResult.totalAvailableCapped;
      hardLimitHit = hardLimitHit || targetResult.totalAvailableCapped;
      for (const file of targetResult.files) {
        files.push(this.toFilePayload(target.state.folder, file));
      }
      remaining -= targetResult.files.length;
      if (remaining <= 0 && index < filesQueryPlan.targets.length - 1) {
        totalAvailableCapped = true;
      }
    }

    const capped = totalAvailableCapped;

    return {
      query,
      ...maxResultsPayload,
      totalAvailable,
      ...(totalAvailableCapped ? { totalAvailableCapped: true } : {}),
      ...(hardLimitHit ? { hardLimitHit: true } : {}),
      count: files.length,
      capped,
      scope: filesQueryPlan.scope,
      querySemanticsApplied: filesQueryPlan.semantics,
      sort: 'qgrep-native',
      files,
    };
  }

  public getStatusSummary(): QgrepStatusSummary {
    const workspaceStatuses: QgrepWorkspaceStatus[] = [];
    let initializedWorkspaces = 0;
    let watchingWorkspaces = 0;

    for (const state of this.states.values()) {
      const initialized = this.isWorkspaceInitialized(state);
      const watching = state.watchProcess !== undefined;
      const progress = initialized
        ? state.progress
        : this.createEmptyProgress();
      const ready = this.isWorkspaceReadyForToolSearch(state);
      if (initialized) {
        initializedWorkspaces += 1;
      }
      if (watching) {
        watchingWorkspaces += 1;
      }
      workspaceStatuses.push({
        workspaceName: state.folder.name,
        initialized,
        watching,
        ready,
        indexedFiles: progress.indexedFiles,
        totalFiles: progress.totalFiles,
        remainingFiles: progress.remainingFiles,
        progressPercent: progress.progressPercent,
        progressKnown: progress.progressKnown,
        indexing: progress.indexing,
        ...(isQgrepRecoveryActive(state) ? {
          recoveryPhase: state.recoveryPhase,
          recoveryAttemptCount: state.recoveryAttemptCount,
          fallbackRebuildPending: state.recoveryPhase === 'fallback-rebuild',
          degraded: state.recoveryPhase === 'degraded',
          ...(state.lastRecoverableError ? { lastRecoverableError: state.lastRecoverableError } : {}),
        } : {}),
      });
    }

    workspaceStatuses.sort((left, right) => left.workspaceName.localeCompare(right.workspaceName));

    return {
      binaryPath: this.binaryPath,
      binaryAvailable: fs.existsSync(this.binaryPath),
      totalWorkspaces: this.states.size,
      initializedWorkspaces,
      watchingWorkspaces,
      workspaceStatuses,
    };
  }

  private createEmptyProgress(): WorkspaceIndexProgress {
    return {
      progressKnown: false,
      indexing: false,
    };
  }

  private notifyStatusChanged(): void {
    if (!qgrepStatusChangeHandler) {
      return;
    }
    try {
      qgrepStatusChangeHandler();
    } catch (error) {
      qgrepLogger.warn(`Qgrep status change handler failed: ${String(error)}`);
    }
  }

  private setWorkspaceIndexing(state: WorkspaceQgrepState, indexing: boolean): void {
    if (state.progress.indexing === indexing) {
      return;
    }
    state.progress.indexing = indexing;
    this.notifyStatusChanged();
  }

  private resetWorkspaceProgress(state: WorkspaceQgrepState): void {
    state.progress = this.createEmptyProgress();
    this.resetStaleWatchTracking(state);
    this.notifyStatusChanged();
  }

  private resetWorkspaceRecovery(state: WorkspaceQgrepState): void {
    const nextState = resetQgrepRecoveryState(state);
    state.recoveryPhase = nextState.recoveryPhase;
    state.recoveryAttemptCount = nextState.recoveryAttemptCount;
    state.lastRecoverableError = nextState.lastRecoverableError;
    state.warningShownForCurrentFailure = nextState.warningShownForCurrentFailure;
    state.watchWasRunningBeforeRebuild = nextState.watchWasRunningBeforeRebuild;
    state.allowExplicitRecovery = nextState.allowExplicitRecovery;
  }

  private isWorkspaceAbnormal(state: WorkspaceQgrepState): boolean {
    return !this.isWorkspaceReadyForToolSearch(state);
  }

  private isWorkspaceRecoveryDegraded(state: WorkspaceQgrepState): boolean {
    return state.recoveryPhase === 'degraded';
  }

  private applyWorkspaceDegradedState(
    state: WorkspaceQgrepState,
    errorSummary: string,
    allowExplicitRecovery: boolean,
  ): void {
    const nextState = markQgrepRecoveryDegraded(state, errorSummary, allowExplicitRecovery);
    state.recoveryPhase = nextState.recoveryPhase;
    state.recoveryAttemptCount = nextState.recoveryAttemptCount;
    state.lastRecoverableError = nextState.lastRecoverableError;
    state.warningShownForCurrentFailure = nextState.warningShownForCurrentFailure;
    state.watchWasRunningBeforeRebuild = nextState.watchWasRunningBeforeRebuild;
    state.allowExplicitRecovery = nextState.allowExplicitRecovery;
    this.notifyStatusChanged();
    this.maybeShowRecoveryWarning(state);
  }

  private maybeShowRecoveryWarning(state: WorkspaceQgrepState): void {
    if (state.warningShownForCurrentFailure || !state.lastRecoverableError) {
      return;
    }
    state.warningShownForCurrentFailure = true;
    const message =
      `${QGREP_RECOVERY_WARNING_PREFIX} for workspace '${state.folder.name}'. `
      + `${state.lastRecoverableError} Run "LM Tools Bridge: Qgrep Rebuild Indexes" if the issue persists.`;
    qgrepLogger.warn(`[qgrep.recovery:${state.folder.name}] ${message}`);
    void vscode.window.showWarningMessage(message);
  }

  private classifyRecoveryFailure(error: unknown, phase: 'update' | 'rebuild' | 'init-update'): 'recoverable' | 'nonrecoverable' {
    const message = String(error).toLowerCase();
    if (
      message.includes('disposed')
      || message.includes('no longer available')
      || message.includes('qgrep binary is not available')
      || message.includes('failed to read qgrep config')
      || message.includes('failed to write qgrep config')
      || message.includes('init failed for workspace')
    ) {
      return 'nonrecoverable';
    }
    if (phase === 'rebuild') {
      return 'recoverable';
    }
    return 'recoverable';
  }

  private beginRecoverableUpdateRetry(state: WorkspaceQgrepState, errorSummary: string): number {
    const decision = advanceQgrepRecoveryAfterRecoverableUpdateFailure(state, errorSummary);
    state.recoveryPhase = decision.nextState.recoveryPhase;
    state.recoveryAttemptCount = decision.nextState.recoveryAttemptCount;
    state.lastRecoverableError = decision.nextState.lastRecoverableError;
    state.warningShownForCurrentFailure = decision.nextState.warningShownForCurrentFailure;
    state.watchWasRunningBeforeRebuild = decision.nextState.watchWasRunningBeforeRebuild;
    state.allowExplicitRecovery = decision.nextState.allowExplicitRecovery;
    this.notifyStatusChanged();
    return decision.delayMs;
  }

  private restartDegradedWorkspaceRecovery(state: WorkspaceQgrepState): void {
    const nextState = beginQgrepExplicitRecovery(state);
    state.recoveryPhase = nextState.recoveryPhase;
    state.recoveryAttemptCount = nextState.recoveryAttemptCount;
    state.lastRecoverableError = nextState.lastRecoverableError;
    state.warningShownForCurrentFailure = nextState.warningShownForCurrentFailure;
    state.watchWasRunningBeforeRebuild = nextState.watchWasRunningBeforeRebuild;
    state.allowExplicitRecovery = nextState.allowExplicitRecovery;
    state.autoUpdateDirty = true;
    qgrepLogger.info(`[qgrep.recovery:${state.folder.name}] restarting degraded recovery on explicit trigger`);
    this.notifyStatusChanged();
  }

  private buildRecoveryErrorMessage(state: WorkspaceQgrepState): string {
    const detail = state.lastRecoverableError ?? 'Qgrep recovery is blocked by a non-recoverable error.';
    return `workspace '${state.folder.name}' is degraded after recovery failed. ${detail}`;
  }

  private buildQgrepUnavailableError(state: WorkspaceQgrepState): QgrepUnavailableError {
    return new QgrepUnavailableError(this.buildRecoveryErrorMessage(state));
  }

  private queueStartupRefreshForInitializedWorkspaces(): void {
    const initializedStates = [...this.states.values()].filter((state) => this.isWorkspaceInitialized(state));
    if (initializedStates.length === 0) {
      return;
    }
    qgrepLogger.info(`[qgrep.startup-update] queueing startup refresh for ${String(initializedStates.length)} workspace(s)`);
    for (const state of initializedStates) {
      this.queueWorkspaceStartupAutoUpdate(state);
    }
  }

  private queueWorkspaceStartupAutoUpdate(state: WorkspaceQgrepState): void {
    if (this.disposed || this.states.get(state.key) !== state) {
      return;
    }
    if (!this.isWorkspaceInitialized(state)) {
      return;
    }
    state.startupRefreshPending = true;
    state.managedSearchExcludeDirty = true;
    state.autoUpdateDirty = true;
    qgrepLogger.info(`[qgrep.startup-update:${state.folder.name}] queued startup refresh`);
    this.scheduleWorkspaceAutoUpdate(state, 0);
  }

  private hasQueuedWorkspaceAutoUpdate(state: WorkspaceQgrepState): boolean {
    return hasQueuedQgrepAutoUpdate({
      startupRefreshPending: state.startupRefreshPending,
      autoUpdateDirty: state.autoUpdateDirty,
      managedSearchExcludeDirty: state.managedSearchExcludeDirty,
      pendingCreateDeleteCount: state.pendingCreateDeleteCount,
    });
  }

  private markWorkspaceIndexingFailed(state: WorkspaceQgrepState): void {
    if (state.progress.progressKnown) {
      return;
    }
    let changed = false;
    if (state.progress.indexedFiles !== undefined) {
      state.progress.indexedFiles = undefined;
      changed = true;
    }
    if (state.progress.remainingFiles !== undefined) {
      state.progress.remainingFiles = undefined;
      changed = true;
    }
    if (state.progress.progressPercent !== undefined) {
      state.progress.progressPercent = undefined;
      changed = true;
    }
    if (changed) {
      this.resetStaleWatchTracking(state);
      this.notifyStatusChanged();
    }
  }

  private applyProgressTextLine(state: WorkspaceQgrepState, rawLine: string): void {
    const line = rawLine.trim();
    if (line.length === 0) {
      return;
    }
    const parsed = QGREP_PROGRESS_FRAME_PATTERN.exec(line);
    if (!parsed) {
      return;
    }
    const percent = Number(parsed[1]);
    const indexedFiles = Number(parsed[2]);
    if (!Number.isFinite(percent) || !Number.isInteger(indexedFiles) || indexedFiles < 0) {
      return;
    }
    this.updateWorkspaceProgress(state, percent, indexedFiles);
  }

  private updateWorkspaceProgress(state: WorkspaceQgrepState, percent: number, indexedFiles: number): void {
    const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    const nextTotal = normalizedPercent === 100
      ? indexedFiles
      : state.progress.totalFiles;
    const nextProgressKnown = nextTotal !== undefined;
    const nextRemaining = nextTotal !== undefined
      ? Math.max(nextTotal - indexedFiles, 0)
      : undefined;
    const nextIndexing = normalizedPercent < 100;
    let changed = false;

    if (state.progress.indexedFiles !== indexedFiles) {
      state.progress.indexedFiles = indexedFiles;
      changed = true;
    }
    if (state.progress.progressPercent !== normalizedPercent) {
      state.progress.progressPercent = normalizedPercent;
      changed = true;
    }
    if (state.progress.totalFiles !== nextTotal) {
      state.progress.totalFiles = nextTotal;
      changed = true;
    }
    if (state.progress.progressKnown !== nextProgressKnown) {
      state.progress.progressKnown = nextProgressKnown;
      changed = true;
    }
    if (state.progress.remainingFiles !== nextRemaining) {
      state.progress.remainingFiles = nextRemaining;
      changed = true;
    }
    if (state.progress.indexing !== nextIndexing) {
      state.progress.indexing = nextIndexing;
      changed = true;
    }

    if (changed) {
      this.refreshStaleWatchHeartbeat(state);
      this.notifyStatusChanged();
    }
  }

  private consumeProgressStream(
    state: WorkspaceQgrepState,
    stream: { pendingText: string },
    text: string,
  ): void {
    const { lines, remainder } = splitIntoCompletedLines(stream.pendingText, text);
    stream.pendingText = remainder;
    for (const line of lines) {
      this.applyProgressTextLine(state, line);
    }
  }

  private flushProgressStream(state: WorkspaceQgrepState, stream: { pendingText: string }): void {
    if (stream.pendingText.trim().length > 0) {
      this.applyProgressTextLine(state, stream.pendingText);
    }
    stream.pendingText = '';
  }

  private buildSummary(
    totalWorkspaces: number,
    processed: number,
    failures: string[],
    message: string,
  ): QgrepCommandSummary {
    return {
      totalWorkspaces,
      processed,
      failed: failures.length,
      message,
      failures,
    };
  }

  private parseQuery(input: Record<string, unknown>): string {
    const value = input.query;
    if (typeof value !== 'string') {
      throw new Error('query must be a string.');
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error('query must be a non-empty string.');
    }
    return trimmed;
  }

  private logIndexCommandCancelledDuringClear(
    state: WorkspaceQgrepState,
    scope: IndexCommandLogScope,
    commandKind: QgrepIndexCommandKind,
  ): void {
    qgrepLogger.info(`[qgrep.${scope}:${state.folder.name}] ${commandKind} cancelled during clear`);
  }

  private classifyWatchLogLineLevel(line: string): 'info' | 'warn' {
    const normalized = line.toLowerCase();
    if (
      normalized.includes('error')
      || normalized.includes('failed')
      || normalized.includes('fatal')
      || normalized.includes('cannot')
      || normalized.includes('unable')
      || normalized.includes('panic')
    ) {
      return 'warn';
    }
    return 'info';
  }

  private logWatchLine(state: WorkspaceQgrepState, line: string): void {
    const level = this.classifyWatchLogLineLevel(line);
    if (level === 'warn') {
      qgrepLogger.warn(`[qgrep.watch:${state.folder.name}] ${line}`);
      return;
    }
    qgrepLogger.info(`[qgrep.watch:${state.folder.name}] ${line}`);
  }

  private parseFilesQuery(input: Record<string, unknown>): string {
    const value = input.query;
    if (typeof value !== 'string') {
      throw new Error('query must be a string.');
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error('query must be a non-empty string.');
    }
    return trimmed;
  }

  private parseOptionalBooleanInput(value: unknown, key: string): boolean | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'boolean') {
      throw new Error(`${key} must be a boolean when provided.`);
    }
    return value;
  }

  private parseTextQuerySyntax(input: Record<string, unknown>): QgrepTextQuerySyntax {
    return parseQuerySyntax({
      input,
      toolName: 'lm_qgrepSearchText',
      allowed: ['literal', 'regex'],
      defaultSyntax: 'literal',
    });
  }

  private parseFilesQuerySyntax(input: Record<string, unknown>): QgrepFilesQuerySyntax {
    return parseQuerySyntax({
      input,
      toolName: 'lm_qgrepSearchFiles',
      allowed: ['glob', 'regex'],
      defaultSyntax: 'glob',
    });
  }

  private parseMaxResults(input: Record<string, unknown>): number {
    const value = input.maxResults;
    if (value === undefined || value === null) {
      return DEFAULT_MAX_RESULTS;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('maxResults must be a finite number when provided.');
    }
    const rounded = Math.floor(value);
    if (rounded !== value || rounded < MIN_MAX_RESULTS) {
      throw new Error(`maxResults must be an integer >= ${MIN_MAX_RESULTS}.`);
    }
    return rounded;
  }

  private buildFilesQueryDraft(input: Record<string, unknown>, query: string): FilesQueryDraft {
    ensureFilesLegacyParamsUnsupported(input);
    const querySyntax = this.parseFilesQuerySyntax(input);
    return buildFilesQueryDraft(
      query,
      querySyntax,
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name),
    );
  }

  private applySearchMaxResultsLimit(maxResults: number): number {
    return Math.min(maxResults, QGREP_TEXT_MAX_RESULTS_LIMIT);
  }

  private buildSearchMaxResultsPayload(maxResults: number): MaxResultsPayload {
    const maxResultsApplied = this.applySearchMaxResultsLimit(maxResults);
    if (maxResults > maxResultsApplied) {
      return {
        maxResultsApplied,
        maxResultsRequested: maxResults,
      };
    }
    return { maxResultsApplied };
  }

  private buildContextLinePayload(
    beforeContextLines: ParsedOptionalContextLineCount,
    afterContextLines: ParsedOptionalContextLineCount,
  ): Record<string, number> {
    return {
      beforeContextLines: beforeContextLines.applied,
      afterContextLines: afterContextLines.applied,
      ...(beforeContextLines.requested !== undefined
        ? { beforeContextLinesRequested: beforeContextLines.requested }
        : {}),
      ...(afterContextLines.requested !== undefined
        ? { afterContextLinesRequested: afterContextLines.requested }
        : {}),
    };
  }

  private buildFilesMaxResultsPayload(maxResults: number): MaxResultsPayload {
    const maxResultsApplied = Math.min(maxResults, QGREP_FILES_MAX_RESULTS_LIMIT);
    if (maxResults > maxResultsApplied) {
      return {
        maxResultsApplied,
        maxResultsRequested: maxResults,
      };
    }
    return { maxResultsApplied };
  }

  private materializeFilesQueryPlan(filesQueryDraft: FilesQueryDraft): FilesQueryPlan {
    return {
      targets: filesQueryDraft.targets.map((target) => {
        const folder = this.requireWorkspaceFolderByName(target.workspaceName);
        const state = this.requireInitializedState(folder);
        if (target.kind === 'regex') {
          return {
            state,
            queryRegex: target.queryRegex,
          };
        }
        if (target.kind === 'glob-absolute') {
          return {
            state,
            queryRegex: this.compileFilesGlobQueryToRegex(target.pattern),
          };
        }
        return {
          state,
          queryRegex: this.compileWorkspaceAnchoredFilesGlobQueryToRegex(folder, target.pattern),
        };
      }),
      scope: filesQueryDraft.scope,
      semantics: filesQueryDraft.semantics,
    };
  }

  private compileFilesGlobQueryToRegex(query: string): string {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new Error("query must be a non-empty glob string when querySyntax is 'glob'.");
    }
    try {
      const regexSource = `^${compileFilesQueryGlobToRegexSource(trimmed)}$`;
      const syntaxError = validateQgrepConfigRegexSyntax(regexSource);
      if (syntaxError) {
        throw new Error(`generated qgrep regex is not supported (${syntaxError}).`);
      }
      return regexSource;
    } catch (error) {
      throw new Error(normalizeFilesQueryGlobErrorMessage(error));
    }
  }

  private compileWorkspaceAnchoredFilesGlobQueryToRegex(
    folder: vscode.WorkspaceFolder,
    query: string,
  ): string {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new Error("query must be a non-empty glob string when querySyntax is 'glob'.");
    }
    try {
      const workspaceRoot = normalizeSlash(path.resolve(folder.uri.fsPath));
      const relativeRegexSource = compileFilesQueryGlobToRegexSource(trimmed);
      const regexSource = `^${escapeRegex(workspaceRoot)}/${relativeRegexSource}$`;
      const syntaxError = validateQgrepConfigRegexSyntax(regexSource);
      if (syntaxError) {
        throw new Error(`generated qgrep regex is not supported (${syntaxError}).`);
      }
      return regexSource;
    } catch (error) {
      throw new Error(normalizeFilesQueryGlobErrorMessage(error));
    }
  }

  private async ensureToolSearchReady(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new Error('No workspace folders are open.');
    }
    this.syncWorkspaceStates(folders);

    const readyPromise = Promise.all(folders.map(async (folder) => {
      const state = this.getStateForFolder(folder);
      if (!state) {
        throw new Error(`Failed to allocate qgrep state for workspace '${folder.name}'.`);
      }
      await this.ensureWorkspaceReadyForToolSearch(state);
    }));

    try {
      await this.waitWithTimeout(readyPromise, TOOL_SEARCH_READY_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof Error && error.message === 'Timed out') {
        throw this.buildToolSearchReadyTimeoutError();
      }
      throw error;
    }
  }

  private async ensureWorkspaceReadyForToolSearch(state: WorkspaceQgrepState): Promise<void> {
    if (this.isWorkspaceReadyForToolSearch(state)) {
      return;
    }
    if (state.toolEnsureReadyPromise) {
      await state.toolEnsureReadyPromise;
      return;
    }

    const promise = this.ensureWorkspaceReadyForToolSearchInternal(state);
    state.toolEnsureReadyPromise = promise;
    this.notifyStatusChanged();
    try {
      await promise;
    } finally {
      if (state.toolEnsureReadyPromise === promise) {
        state.toolEnsureReadyPromise = undefined;
        this.notifyStatusChanged();
      }
    }
  }

  private async ensureWorkspaceReadyForToolSearchInternal(state: WorkspaceQgrepState): Promise<void> {
    while (true) {
      if (this.disposed) {
        throw new Error('Qgrep service is disposed.');
      }
      if (this.states.get(state.key) !== state) {
        throw new Error(`Workspace '${state.folder.name}' is no longer available.`);
      }
      if (this.isWorkspaceRecoveryDegraded(state)) {
        throw this.buildQgrepUnavailableError(state);
      }

      if (!this.isWorkspaceInitialized(state)) {
        try {
          await this.initWorkspace(state);
        } catch (error) {
          if (this.isWorkspaceRecoveryDegraded(state) || isQgrepUnavailableError(error)) {
            throw this.buildQgrepUnavailableError(state);
          }
          if (this.hasQueuedWorkspaceAutoUpdate(state) || isQgrepRecoveryActive(state)) {
            qgrepLogger.warn(`[qgrep.ready:${state.folder.name}] init failed but recovery is queued: ${String(error)}`);
            continue;
          }
          throw error;
        }
        continue;
      }
      if (
        (this.hasQueuedWorkspaceAutoUpdate(state) || isQgrepRecoveryActive(state))
        && !state.autoUpdateInFlight
        && !state.progress.indexing
        && state.pendingIndexOperationCount === 0
      ) {
        await this.runQueuedWorkspaceAutoUpdate(state);
        continue;
      }
      if (this.isWorkspaceReadyForToolSearch(state)) {
        return;
      }

      await delayMs(TOOL_SEARCH_READY_POLL_INTERVAL_MS);
    }
  }

  private isWorkspaceReadyForToolSearch(state: WorkspaceQgrepState): boolean {
    return isQgrepWorkspaceReadyForToolSearch({
      initialized: this.isWorkspaceInitialized(state),
      pendingIndexOperationCount: state.pendingIndexOperationCount,
      autoUpdateInFlight: state.autoUpdateInFlight,
      startupRefreshPending: state.startupRefreshPending,
      autoUpdateDirty: state.autoUpdateDirty,
      managedSearchExcludeDirty: state.managedSearchExcludeDirty,
      pendingCreateDeleteCount: state.pendingCreateDeleteCount,
      recoveryPhase: state.recoveryPhase,
      recoveryAttemptCount: state.recoveryAttemptCount,
      lastRecoverableError: state.lastRecoverableError,
      warningShownForCurrentFailure: state.warningShownForCurrentFailure,
      watchWasRunningBeforeRebuild: state.watchWasRunningBeforeRebuild,
      allowExplicitRecovery: state.allowExplicitRecovery,
      progress: state.progress,
    });
  }

  private async waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Timed out'));
          }, Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private buildToolSearchReadyTimeoutError(): Error {
    const waitingStates = [...this.states.values()].filter((state) => !this.isWorkspaceReadyForToolSearch(state));
    const details = waitingStates.length === 1
      ? this.describeWorkspaceToolReadiness(waitingStates[0])
      : waitingStates
        .map((state) => state.folder.name)
        .join(', ');
    if (waitingStates.length === 1) {
      return new Error(
        `timed out after ${String(Math.floor(TOOL_SEARCH_READY_TIMEOUT_MS / 1000))}s while waiting for workspace '${waitingStates[0]!.folder.name}' to finish indexing (${details}).`,
      );
    }
    return new Error(
      `timed out after ${String(Math.floor(TOOL_SEARCH_READY_TIMEOUT_MS / 1000))}s while waiting for workspaces to finish indexing (${details || 'unknown workspace state'}).`,
    );
  }

  private describeWorkspaceToolReadiness(state: WorkspaceQgrepState): string {
    const parts: string[] = [];
    parts.push(`initialized=${String(this.isWorkspaceInitialized(state))}`);
    parts.push(`pendingOps=${String(state.pendingIndexOperationCount)}`);
    parts.push(`autoUpdateInFlight=${String(state.autoUpdateInFlight)}`);
    parts.push(`queuedAutoUpdate=${String(this.hasQueuedWorkspaceAutoUpdate(state))}`);
    if (isQgrepRecoveryActive(state)) {
      parts.push(`recoveryPhase=${state.recoveryPhase}`);
      parts.push(`recoveryAttemptCount=${String(state.recoveryAttemptCount)}`);
    }
    parts.push(`indexing=${String(state.progress.indexing)}`);
    parts.push(`progressKnown=${String(state.progress.progressKnown)}`);
    if (state.progress.progressPercent !== undefined) {
      parts.push(`progressPercent=${String(state.progress.progressPercent)}`);
    }
    return parts.join(', ');
  }

  private isGlobPathScope(pathScope: string): boolean {
    const trimmed = pathScope.trim();
    if (trimmed.length === 0) {
      return false;
    }
    try {
      const normalized = normalizeWorkspaceSearchGlobPattern(trimmed);
      return hasUnescapedGlobMeta(normalized);
    } catch {
      return hasUnescapedGlobMeta(trimmed);
    }
  }

  private async searchWithGlobPathScope(
    pathScope: string,
    query: string,
    backendQuery: string,
    querySemanticsApplied: QgrepTextQuerySemantics,
    casePolicy: QgrepTextCasePolicy,
    useCaseInsensitiveSearch: boolean,
    maxResultsPayload: MaxResultsPayload,
    queryHints: readonly string[],
    beforeContextLines: ParsedOptionalContextLineCount,
    afterContextLines: ParsedOptionalContextLineCount,
  ): Promise<Record<string, unknown>> {
    const maxResultsApplied = maxResultsPayload.maxResultsApplied;
    const contextLinesPayload = this.buildContextLinePayload(beforeContextLines, afterContextLines);
    const targets = this.resolveGlobSearchTargets(pathScope);
    if (targets.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const matches: Array<Record<string, unknown>> = [];
    let totalAvailable = 0;
    let totalAvailableCapped = false;
    let hardLimitHit = false;

    for (const target of targets) {
      const targetResult = await this.searchInWorkspace(
        { state: target.state, filterRegex: target.textFilterRegex },
        backendQuery,
        useCaseInsensitiveSearch,
        maxResultsApplied,
      );
      totalAvailable += targetResult.matches.length;
      totalAvailableCapped = totalAvailableCapped || targetResult.totalAvailableCapped;
      hardLimitHit = hardLimitHit
        || (targetResult.totalAvailableCapped && targetResult.limitApplied >= QGREP_TEXT_MAX_RESULTS_LIMIT);

      if (matches.length >= maxResultsApplied) {
        continue;
      }
      const remaining = maxResultsApplied - matches.length;
      const selectedMatches = targetResult.matches.slice(0, remaining);
      for (const match of selectedMatches) {
        matches.push(this.toMatchPayload(target.state.folder, match));
      }
    }

    const capped = totalAvailableCapped || matches.length < totalAvailable;

    return {
      query,
      pathScope,
      ...maxResultsPayload,
      totalAvailable,
      ...(totalAvailableCapped ? { totalAvailableCapped: true } : {}),
      ...(hardLimitHit ? { hardLimitHit: true } : {}),
      count: matches.length,
      capped,
      querySemanticsApplied,
      casePolicy,
      caseModeApplied: useCaseInsensitiveSearch ? 'insensitive' : 'sensitive',
      ...(queryHints.length > 0 ? { queryHints: [...queryHints] } : {}),
      ...contextLinesPayload,
      matches,
    };
  }

  private resolveGlobSearchTargets(pathScope: string): QgrepGlobSearchTarget[] {
    const trimmed = pathScope.trim();
    if (isAbsolutePath(trimmed)) {
      const matcher = compileAbsoluteGlobPathMatcher(trimmed);
      return this.getInitializedStates().map((state) => this.createGlobSearchTarget(state, matcher));
    }

    const scoped = tryResolveWorkspaceScopePattern(
      trimmed,
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name),
    );
    if (scoped) {
      return scoped.targets.map((target) => {
        const matcher = compileWorkspaceGlobPathMatcher(target.pattern);
        const state = this.requireInitializedState(this.requireWorkspaceFolderByName(target.workspaceName));
        return this.createGlobSearchTarget(state, matcher);
      });
    }

    const matcher = compileWorkspaceGlobPathMatcher(trimmed);
    return this.getInitializedStates().map((state) => this.createGlobSearchTarget(state, matcher));
  }

  private createGlobSearchTarget(
    state: WorkspaceQgrepState,
    matcher: QgrepGlobPathMatcher,
  ): QgrepGlobSearchTarget {
    return {
      state,
      matcher,
      textFilterRegex: this.buildTextFilterRegexForGlobMatcher(state.folder, matcher),
    };
  }

  private buildTextFilterRegexForGlobMatcher(
    folder: vscode.WorkspaceFolder,
    matcher: QgrepGlobPathMatcher,
  ): string {
    const regexSource = matcher.matchTarget === 'absolute'
      ? `^${matcher.pathRegexSource}$`
      : `^${escapeRegex(normalizeSlash(path.resolve(folder.uri.fsPath)))}/${matcher.pathRegexSource}$`;
    const syntaxError = validateQgrepConfigRegexSyntax(regexSource);
    if (syntaxError) {
      throw new Error(
        `Invalid pathScope glob pattern: generated qgrep regex is not supported (${syntaxError}).`,
      );
    }
    return regexSource;
  }

  private resolveSearchTargets(pathScope: string | undefined): QgrepSearchTarget[] {
    if (!pathScope) {
      return this.getInitializedStates().map((state) => ({ state }));
    }
    const resolved = this.resolvePathScope(pathScope);
    const filterRegex = this.buildFilterRegex(resolved.state.folder, resolved.absolutePath);
    return [{
      state: resolved.state,
      ...(filterRegex ? { filterRegex } : {}),
    }];
  }

  private resolvePathScope(inputPath: string): ResolvedSearchPath {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new Error('No workspace folders are open.');
    }

    const trimmed = inputPath.trim();
    if (isAbsolutePath(trimmed)) {
      const absolutePath = path.resolve(trimmed);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`pathScope does not exist: ${inputPath}`);
      }
      const folder = this.findWorkspaceForAbsolutePath(absolutePath);
      if (!folder) {
        throw new Error(`pathScope is outside current workspaces: ${inputPath}`);
      }
      const state = this.requireInitializedState(folder);
      return { state, absolutePath };
    }

    const prefixed = this.tryResolveWorkspacePrefixedPath(trimmed);
    if (prefixed) {
      const absolutePath = path.resolve(prefixed.folder.uri.fsPath, prefixed.remainder);
      if (!isPathInsideRoot(prefixed.folder.uri.fsPath, absolutePath)) {
        throw new Error(`pathScope resolves outside workspace '${prefixed.folder.name}': ${inputPath}`);
      }
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`pathScope does not exist: ${inputPath}`);
      }
      const state = this.requireInitializedState(prefixed.folder);
      return { state, absolutePath };
    }

    const matches: Array<{ folder: vscode.WorkspaceFolder; absolutePath: string }> = [];
    for (const folder of folders) {
      const absolutePath = path.resolve(folder.uri.fsPath, trimmed);
      if (!isPathInsideRoot(folder.uri.fsPath, absolutePath)) {
        continue;
      }
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      matches.push({ folder, absolutePath });
    }

    if (matches.length === 0) {
      throw new Error(`pathScope was not found in current workspaces: ${inputPath}`);
    }
    if (matches.length > 1) {
      const candidates = matches.map((item) => item.folder.name).join(', ');
      throw new Error(`pathScope is ambiguous across workspaces (${candidates}). Use WorkspaceName/... form.`);
    }

    const onlyMatch = matches[0];
    const state = this.requireInitializedState(onlyMatch.folder);
    return {
      state,
      absolutePath: onlyMatch.absolutePath,
    };
  }

  private tryResolveWorkspacePrefixedPath(inputPath: string): {
    folder: vscode.WorkspaceFolder;
    remainder: string;
  } | undefined {
    const normalized = normalizeSlash(inputPath).replace(/^\/+/u, '');
    if (normalized.length === 0) {
      return undefined;
    }
    const slashIndex = normalized.indexOf('/');
    const workspaceName = slashIndex >= 0 ? normalized.slice(0, slashIndex) : normalized;
    const folder = this.findWorkspaceFolderByName(workspaceName);
    if (!folder) {
      return undefined;
    }
    const remainder = slashIndex >= 0
      ? normalized.slice(slashIndex + 1).replace(/^\/+/u, '')
      : '.';
    return {
      folder,
      remainder,
    };
  }

  private buildFilterRegex(folder: vscode.WorkspaceFolder, absolutePath: string): string | undefined {
    const resolvedFolderPath = path.resolve(folder.uri.fsPath);
    const resolvedTargetPath = path.resolve(absolutePath);
    if (normalizeForComparison(resolvedFolderPath) === normalizeForComparison(resolvedTargetPath)) {
      return undefined;
    }

    const stats = fs.statSync(resolvedTargetPath);
    const normalizedTargetPath = normalizeSlash(resolvedTargetPath);
    const escaped = escapeRegex(normalizedTargetPath);
    if (stats.isDirectory()) {
      return `^${escaped}(/|$)`;
    }
    return `^${escaped}$`;
  }

  private async searchInWorkspace(
    target: QgrepSearchTarget,
    query: string,
    useCaseInsensitiveSearch: boolean,
    requestedLimit: number,
  ): Promise<WorkspaceSearchResult> {
    const limitApplied = Math.max(MIN_MAX_RESULTS, Math.floor(requestedLimit));
    const args: string[] = ['search', target.state.configPath];
    args.push(`L${limitApplied}`);
    args.push('S');
    if (useCaseInsensitiveSearch) {
      args.push('i');
    }
    if (target.filterRegex) {
      args.push(`fi${encodeRegexForQgrepSearchOption(target.filterRegex)}`);
    }
    args.push(query);

    const result = await this.runQgrepCommand(args, target.state.folder.uri.fsPath);
    const commandError = this.extractCommandError(result, `Search failed for workspace '${target.state.folder.name}'.`);
    if (commandError) {
      throw new Error(commandError);
    }
    const summary = parseQgrepResultSummary(result.stdout);
    return {
      matches: this.parseSearchOutput(result.stdout, target.state.folder),
      limitApplied,
      totalAvailableCapped: summary.capped,
    };
  }

  private shouldUseCaseInsensitiveSearchForQuery(
    querySyntax: QgrepTextQuerySyntax,
    query: string,
    parsedLiteralQuery?: ReturnType<typeof parseLiteralTextQuery>,
  ): boolean {
    if (querySyntax === 'regex') {
      return !/[A-Z]/u.test(query);
    }
    return parsedLiteralQuery ? !parsedLiteralQuery.hasUppercaseLiteral : true;
  }

  private async searchFilesInWorkspace(
    state: WorkspaceQgrepState,
    queryRegex: string,
    requestedLimit: number,
  ): Promise<WorkspaceFilesResult> {
    const limitApplied = Math.max(MIN_MAX_RESULTS, Math.floor(requestedLimit));
    const args: string[] = ['files', state.configPath];
    if (process.platform === 'win32') {
      args.push('i');
    }
    args.push(`L${limitApplied}`);
    args.push('S');
    args.push('fp');
    args.push(queryRegex);

    const result = await this.runQgrepCommand(args, state.folder.uri.fsPath);
    const commandError = this.extractCommandError(result, `File search failed for workspace '${state.folder.name}'.`);
    if (commandError) {
      throw new Error(commandError);
    }
    const summary = parseQgrepResultSummary(result.stdout);
    return {
      files: this.parseFilesOutput(result.stdout, state.folder),
      totalAvailableCapped: summary.capped,
    };
  }

  private parseSearchOutput(stdout: string, folder: vscode.WorkspaceFolder): ParsedQgrepMatch[] {
    const lines = stdout.split(/\r?\n/u);
    const matches: ParsedQgrepMatch[] = [];

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) {
        continue;
      }
      const parsed = /^(.+?):(\d+):(.*)$/u.exec(line);
      if (!parsed) {
        continue;
      }

      const rawPath = parsed[1];
      const rawLineNumber = parsed[2];
      const preview = parsed[3];

      const absolutePath = isAbsolutePath(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(folder.uri.fsPath, rawPath);

      if (!isPathInsideRoot(folder.uri.fsPath, absolutePath)) {
        continue;
      }

      const lineNumber = Number(rawLineNumber);
      if (!Number.isInteger(lineNumber) || lineNumber <= 0) {
        continue;
      }

      matches.push({
        absolutePath,
        line: lineNumber,
        preview,
      });
    }

    return matches;
  }

  private parseFilesOutput(
    stdout: string,
    folder: vscode.WorkspaceFolder,
  ): ParsedQgrepFile[] {
    const lines = stdout.split(/\r?\n/u);
    const files: ParsedQgrepFile[] = [];
    const seen = new Set<string>();

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const parsed = this.tryParseFilesOutputLine(line, folder);
      if (!parsed) {
        continue;
      }
      const key = normalizeForComparison(parsed.absolutePath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      files.push(parsed);
    }

    return files;
  }

  private tryParseFilesOutputLine(
    rawLine: string,
    folder: vscode.WorkspaceFolder,
  ): ParsedQgrepFile | undefined {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      return undefined;
    }
    if (isQgrepSummaryLine(line)) {
      return undefined;
    }

    const direct = this.tryResolveFileOutputPath(folder, line);
    if (direct) {
      return { absolutePath: direct };
    }
    return undefined;
  }

  private tryResolveFileOutputPath(folder: vscode.WorkspaceFolder, rawPath: string): string | undefined {
    const trimmed = rawPath.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const absolutePath = isAbsolutePath(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(folder.uri.fsPath, trimmed);
    if (!isPathInsideRoot(folder.uri.fsPath, absolutePath)) {
      return undefined;
    }
    return absolutePath;
  }

  private toMatchPayload(folder: vscode.WorkspaceFolder, match: ParsedQgrepMatch): Record<string, unknown> {
    const absolutePath = normalizeSlash(path.resolve(match.absolutePath));
    const relativePath = normalizeSlash(path.relative(folder.uri.fsPath, match.absolutePath));
    const workspacePath = relativePath.length > 0 ? `${folder.name}/${relativePath}` : folder.name;
    return {
      absolutePath,
      workspacePath,
      workspaceFolder: folder.name,
      line: match.line,
      preview: match.preview,
    };
  }

  private toFilePayload(folder: vscode.WorkspaceFolder, file: ParsedQgrepFile): Record<string, unknown> {
    const absolutePath = normalizeSlash(path.resolve(file.absolutePath));
    const relativePath = normalizeSlash(path.relative(folder.uri.fsPath, file.absolutePath));
    const workspacePath = relativePath.length > 0 ? `${folder.name}/${relativePath}` : folder.name;
    return {
      absolutePath,
      workspacePath,
      workspaceFolder: folder.name,
    };
  }

  private findWorkspaceForAbsolutePath(absolutePath: string): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const normalizedTarget = normalizeForComparison(absolutePath);
    let best: vscode.WorkspaceFolder | undefined;
    let bestLength = -1;

    for (const folder of folders) {
      const normalizedRoot = normalizeForComparison(folder.uri.fsPath);
      const relative = path.relative(normalizedRoot, normalizedTarget);
      const inside = !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
      if (!inside) {
        continue;
      }
      if (normalizedRoot.length > bestLength) {
        best = folder;
        bestLength = normalizedRoot.length;
      }
    }

    return best;
  }

  private findWorkspaceFolderByName(name: string): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const expected = process.platform === 'win32' ? name.toLowerCase() : name;
    return folders.find((folder) => {
      const folderName = process.platform === 'win32' ? folder.name.toLowerCase() : folder.name;
      return folderName === expected;
    });
  }

  private requireWorkspaceFolderByName(name: string): vscode.WorkspaceFolder {
    const folder = this.findWorkspaceFolderByName(name);
    if (!folder) {
      throw new Error(`Workspace '${name}' is no longer available.`);
    }
    return folder;
  }

  private requireInitializedState(folder: vscode.WorkspaceFolder): WorkspaceQgrepState {
    const state = this.getStateForFolder(folder);
    if (!state || !this.isWorkspaceInitialized(state)) {
      throw new Error(`Workspace '${folder.name}' is not initialized for qgrep. ${INIT_COMMAND_HINT}`);
    }
    return state;
  }

  private handleWorkspaceFolderChanges(event: vscode.WorkspaceFoldersChangeEvent): void {
    let changed = false;
    for (const removed of event.removed) {
      const key = this.folderKey(removed);
      const state = this.states.get(key);
      if (!state) {
        continue;
      }
      this.stopWatch(state);
      this.stopAutoUpdateWatcher(state);
      this.states.delete(key);
      changed = true;
    }

    for (const added of event.added) {
      const key = this.folderKey(added);
      if (this.states.has(key)) {
        continue;
      }
      const state = this.createState(added);
      this.states.set(key, state);
      if (this.isWorkspaceInitialized(state)) {
        this.startWatch(state);
        this.ensureAutoUpdateWatcher(state);
      }
      changed = true;
    }

    if (changed) {
      this.notifyStatusChanged();
    }
  }

  private syncWorkspaceStates(folders: readonly vscode.WorkspaceFolder[]): void {
    let changed = false;
    const expectedKeys = new Set<string>();
    for (const folder of folders) {
      const key = this.folderKey(folder);
      expectedKeys.add(key);
      if (!this.states.has(key)) {
        this.states.set(key, this.createState(folder));
        changed = true;
      } else {
        const state = this.states.get(key);
        if (state) {
          state.folder = folder;
        }
      }
    }

    for (const [key, state] of this.states.entries()) {
      if (expectedKeys.has(key)) {
        continue;
      }
      this.stopWatch(state);
      this.stopAutoUpdateWatcher(state);
      this.states.delete(key);
      changed = true;
    }

    if (changed) {
      this.notifyStatusChanged();
    }
  }

  private createState(folder: vscode.WorkspaceFolder): WorkspaceQgrepState {
    const qgrepDirPath = path.join(folder.uri.fsPath, '.vscode', QGREP_DIR_NAME);
    const configPath = path.join(qgrepDirPath, QGREP_CONFIG_FILE_NAME);
    return {
      key: this.folderKey(folder),
      folder,
      qgrepDirPath,
      configPath,
      progress: this.createEmptyProgress(),
      autoUpdateInFlight: false,
      autoUpdateDirty: false,
      pendingCreateDeleteCount: 0,
      pendingIndexOperationCount: 0,
      managedSearchExcludeDirty: false,
      restartOnExit: false,
      startupRefreshPending: false,
      startupAutoRepairAttempted: false,
      staleWatchRestartCount: 0,
      ...createEmptyQgrepRecoveryState(),
    };
  }

  private getStateForFolder(folder: vscode.WorkspaceFolder): WorkspaceQgrepState | undefined {
    const key = this.folderKey(folder);
    return this.states.get(key);
  }

  private folderKey(folder: vscode.WorkspaceFolder): string {
    return folder.uri.toString();
  }

  private getInitializedStates(): WorkspaceQgrepState[] {
    return [...this.states.values()].filter((state) => this.isWorkspaceInitialized(state));
  }

  private isWorkspaceInitialized(state: WorkspaceQgrepState): boolean {
    return fs.existsSync(state.configPath);
  }

  private async runWorkspaceIndexOperationExclusive(
    state: WorkspaceQgrepState,
    operation: () => Promise<void>,
  ): Promise<void> {
    state.pendingIndexOperationCount += 1;
    this.notifyStatusChanged();

    const previousChain = state.indexOperationChain;
    const nextChain = (previousChain ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await operation();
      });

    state.indexOperationChain = nextChain;

    try {
      await nextChain;
    } finally {
      state.pendingIndexOperationCount = Math.max(0, state.pendingIndexOperationCount - 1);
      if (state.indexOperationChain === nextChain) {
        state.indexOperationChain = undefined;
      }
      this.notifyStatusChanged();
    }
  }

  private startWatchForInitializedWorkspaces(): void {
    for (const state of this.states.values()) {
      if (!this.isWorkspaceInitialized(state)) {
        continue;
      }
      this.startWatch(state);
    }
  }

  private startWatchHealthChecks(): void {
    if (this.watchHealthTimer) {
      clearInterval(this.watchHealthTimer);
    }
    this.watchHealthTimer = setInterval(() => {
      this.checkForStaleWatchProgress();
    }, WATCH_STALE_CHECK_INTERVAL_MS);
  }

  private checkForStaleWatchProgress(): void {
    const nowMs = Date.now();
    for (const state of this.states.values()) {
      if (!shouldRecoverStaleQgrepWatch(this.toWatchStalenessState(state), nowMs, WATCH_STALE_PROGRESS_TIMEOUT_MS)) {
        continue;
      }
      this.recoverStaleWatchProgress(state, nowMs);
    }
  }

  private toWatchStalenessState(state: WorkspaceQgrepState) {
    return {
      watchRunning: state.watchProcess !== undefined,
      lastProgressFrameAt: state.lastProgressFrameAt,
      initialized: this.isWorkspaceInitialized(state),
      pendingIndexOperationCount: state.pendingIndexOperationCount,
      autoUpdateInFlight: state.autoUpdateInFlight,
      startupRefreshPending: state.startupRefreshPending,
      autoUpdateDirty: state.autoUpdateDirty,
      managedSearchExcludeDirty: state.managedSearchExcludeDirty,
      pendingCreateDeleteCount: state.pendingCreateDeleteCount,
      recoveryPhase: state.recoveryPhase,
      recoveryAttemptCount: state.recoveryAttemptCount,
      lastRecoverableError: state.lastRecoverableError,
      warningShownForCurrentFailure: state.warningShownForCurrentFailure,
      watchWasRunningBeforeRebuild: state.watchWasRunningBeforeRebuild,
      allowExplicitRecovery: state.allowExplicitRecovery,
      progress: state.progress,
    };
  }

  private recoverStaleWatchProgress(state: WorkspaceQgrepState, nowMs: number): void {
    const signature = this.getIncompleteProgressSignature(state);
    if (!signature) {
      this.resetStaleWatchTracking(state);
      return;
    }

    const lastProgressFrameAt = state.lastProgressFrameAt ?? nowMs;
    const stalledForMs = Math.max(nowMs - lastProgressFrameAt, 0);
    if (
      state.staleWatchRestartCount >= WATCH_STALE_MAX_RESTARTS
      && state.staleWatchRecoverySignature === signature
    ) {
      this.triggerStaleWatchRebuild(state, signature, stalledForMs);
      return;
    }
    this.restartStaleWatch(state, signature, stalledForMs);
  }

  private restartStaleWatch(
    state: WorkspaceQgrepState,
    signature: string,
    stalledForMs: number,
  ): void {
    state.staleWatchRestartCount += 1;
    state.staleWatchRecoverySignature = signature;
    state.lastProgressFrameAt = Date.now();
    qgrepLogger.warn(
      `[qgrep.watch:${state.folder.name}] no new progress frame for ${String(stalledForMs)}ms at ${signature}; restarting watch (${String(state.staleWatchRestartCount)}/${String(WATCH_STALE_MAX_RESTARTS)})`,
    );
    this.stopWatch(state);
    if (!this.disposed && this.isWorkspaceInitialized(state)) {
      this.startWatch(state);
    }
  }

  private triggerStaleWatchRebuild(
    state: WorkspaceQgrepState,
    signature: string,
    stalledForMs: number,
  ): void {
    state.lastProgressFrameAt = Date.now();
    qgrepLogger.warn(
      `[qgrep.watch:${state.folder.name}] no new progress frame for ${String(stalledForMs)}ms at ${signature} after ${String(state.staleWatchRestartCount)} stale restart(s); rebuilding index`,
    );
    void this.rebuildWorkspace(state)
      .then(() => {
        this.resetStaleWatchTracking(state);
      })
      .catch((error) => {
        const errorSummary = `Stale watch recovery rebuild failed for workspace '${state.folder.name}'. ${String(error)}`;
        this.applyWorkspaceDegradedState(state, errorSummary, this.classifyRecoveryFailure(error, 'rebuild') === 'recoverable');
      });
  }

  private getIncompleteProgressSignature(state: WorkspaceQgrepState): string | undefined {
    if (!state.progress.progressKnown) {
      return undefined;
    }
    const percent = state.progress.progressPercent ?? 0;
    const indexedFiles = state.progress.indexedFiles;
    if (percent >= 100 || typeof indexedFiles !== 'number' || !Number.isInteger(indexedFiles) || indexedFiles < 0) {
      return undefined;
    }
    return `${String(indexedFiles)} files @ ${String(percent)}%`;
  }

  private refreshStaleWatchHeartbeat(state: WorkspaceQgrepState): void {
    const signature = this.getIncompleteProgressSignature(state);
    if (!signature) {
      this.resetStaleWatchTracking(state);
      return;
    }
    state.lastProgressFrameAt = Date.now();
    if (state.staleWatchRecoverySignature !== signature) {
      state.staleWatchRestartCount = 0;
      state.staleWatchRecoverySignature = signature;
    }
  }

  private resetStaleWatchTracking(state: WorkspaceQgrepState): void {
    state.lastProgressFrameAt = undefined;
    state.staleWatchRestartCount = 0;
    state.staleWatchRecoverySignature = undefined;
  }

  private cancelWorkspaceIndexCommandForClear(state: WorkspaceQgrepState): void {
    const child = state.activeIndexCommandProcess;
    const kind = state.activeIndexCommandKind;
    if (!child) {
      return;
    }
    state.activeIndexCommandCancelledProcess = child;
    qgrepLogger.info(
      `[qgrep.clear:${state.folder.name}] cancelling active ${kind ?? 'index'} command before clearing indexes`,
    );
    try {
      child.kill();
    } catch (error) {
      qgrepLogger.warn(`[qgrep.clear:${state.folder.name}] failed to cancel index command: ${String(error)}`);
    }
  }

  private async waitForChildProcessExitForClear(
    state: WorkspaceQgrepState,
    child: ChildProcessWithoutNullStreams | undefined,
    processLabel: string,
  ): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    qgrepLogger.info(`[qgrep.clear:${state.folder.name}] waiting for ${processLabel} process to exit before clearing indexes`);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        child.off('close', handleClose);
        child.off('error', handleError);
        resolve();
      };
      const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        qgrepLogger.info(
          `[qgrep.clear:${state.folder.name}] ${processLabel} process exited before clear (code=${String(code)}, signal=${String(signal)})`,
        );
        finish();
      };
      const handleError = (error: Error): void => {
        qgrepLogger.warn(`[qgrep.clear:${state.folder.name}] ${processLabel} process exit wait saw error: ${String(error)}`);
        finish();
      };
      const timeoutHandle = setTimeout(() => {
        qgrepLogger.warn(
          `[qgrep.clear:${state.folder.name}] ${processLabel} process did not exit within ${String(CLEAR_PROCESS_EXIT_TIMEOUT_MS)}ms before clearing indexes`,
        );
        finish();
      }, CLEAR_PROCESS_EXIT_TIMEOUT_MS);
      child.once('close', handleClose);
      child.once('error', handleError);
    });
  }

  private async removeWorkspaceIndexDirectoryForClear(state: WorkspaceQgrepState): Promise<void> {
    await retryQgrepClearRemoval(
      async () => {
        await fs.promises.rm(state.qgrepDirPath, { recursive: true, force: true });
      },
      {
        onRetry: async ({ attempt, delayMs, error }) => {
          qgrepLogger.warn(
            `[qgrep.clear:${state.folder.name}] retrying qgrep directory removal after ${String(error)} (attempt ${String(attempt)}, next delay ${String(delayMs)}ms)`,
          );
        },
      },
    );
  }

  private startAutoUpdateWatchersForInitializedWorkspaces(): void {
    for (const state of this.states.values()) {
      if (!this.isWorkspaceInitialized(state)) {
        continue;
      }
      this.ensureAutoUpdateWatcher(state);
    }
  }

  private startWatch(state: WorkspaceQgrepState): void {
    if (this.disposed || state.watchProcess) {
      return;
    }
    if (!this.isWorkspaceInitialized(state)) {
      return;
    }

    if (!fs.existsSync(this.binaryPath)) {
      qgrepLogger.warn(`Qgrep binary missing at ${this.binaryPath}. Watch skipped for '${state.folder.name}'.`);
      return;
    }

    const child = spawn(this.binaryPath, ['watch', state.configPath], {
      cwd: state.folder.uri.fsPath,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    state.watchProcess = child;
    state.restartOnExit = true;
    this.refreshStaleWatchHeartbeat(state);
    this.notifyStatusChanged();
    const stdoutProgress = { pendingText: '' };
    const stdoutLogLines = { pendingText: '' };
    const stderrLines = { pendingText: '' };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.consumeProgressStream(state, stdoutProgress, text);
      const parsed = splitIntoCompletedLines(stdoutLogLines.pendingText, text);
      stdoutLogLines.pendingText = parsed.remainder;
      for (const rawLine of parsed.lines) {
        const line = rawLine.trim();
        if (line.length > 0) {
          qgrepLogger.info(`[qgrep.watch:${state.folder.name}] ${line}`);
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const parsed = splitIntoCompletedLines(stderrLines.pendingText, text);
      stderrLines.pendingText = parsed.remainder;
      for (const rawLine of parsed.lines) {
        const line = rawLine.trim();
        if (line.length > 0) {
          this.logWatchLine(state, line);
        }
      }
    });

    child.on('error', (error) => {
      qgrepLogger.error(`[qgrep.watch:${state.folder.name}] process error: ${String(error)}`);
    });
    child.on('close', (code, signal) => {
      this.flushProgressStream(state, stdoutProgress);
      if (stdoutLogLines.pendingText.trim().length > 0) {
        qgrepLogger.info(`[qgrep.watch:${state.folder.name}] ${stdoutLogLines.pendingText.trim()}`);
      }
      if (stderrLines.pendingText.trim().length > 0) {
        this.logWatchLine(state, stderrLines.pendingText.trim());
      }
      qgrepLogger.info(
        `[qgrep.watch:${state.folder.name}] process closed (code=${String(code)}, signal=${String(signal)}, restartOnExit=${String(state.restartOnExit)})`,
      );
      if (state.watchProcess !== child) {
        return;
      }
      state.watchProcess = undefined;
      this.notifyStatusChanged();
      if (!state.restartOnExit || this.disposed || !this.isWorkspaceInitialized(state)) {
        return;
      }
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
      }
      state.restartTimer = setTimeout(() => {
        state.restartTimer = undefined;
        this.startWatch(state);
      }, WATCH_RESTART_DELAY_MS);
    });
  }

  private stopWatch(state: WorkspaceQgrepState): void {
    state.restartOnExit = false;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = undefined;
    }
    const watch = state.watchProcess;
    if (!watch) {
      return;
    }
    state.watchProcess = undefined;
    this.notifyStatusChanged();
    qgrepLogger.info(`[qgrep.watch:${state.folder.name}] stopping watch process`);
    try {
      watch.kill();
    } catch {
      // Ignore kill failures.
    }
  }

  private ensureAutoUpdateWatcher(state: WorkspaceQgrepState): void {
    if (this.disposed || state.fsWatcher) {
      return;
    }
    if (!this.isWorkspaceInitialized(state)) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(state.folder, '**/*'));
    state.fsWatcher = watcher;
    watcher.onDidCreate((uri) => {
      this.handleAutoUpdateFileSystemEvent(state, uri, 'create');
    });
    watcher.onDidDelete((uri) => {
      this.handleAutoUpdateFileSystemEvent(state, uri, 'delete');
    });
  }

  private stopAutoUpdateWatcher(state: WorkspaceQgrepState): void {
    if (state.autoUpdateTimer) {
      clearTimeout(state.autoUpdateTimer);
      state.autoUpdateTimer = undefined;
    }
    state.autoUpdateDirty = false;
    state.pendingCreateDeleteCount = 0;
    state.managedSearchExcludeDirty = false;

    const watcher = state.fsWatcher;
    if (!watcher) {
      return;
    }
    state.fsWatcher = undefined;
    try {
      watcher.dispose();
    } catch {
      // Ignore dispose failures.
    }
  }

  private handleAutoUpdateFileSystemEvent(
    state: WorkspaceQgrepState,
    uri: vscode.Uri,
    reason: 'create' | 'delete',
  ): void {
    if (!this.shouldQueueAutoUpdateForUri(state, uri)) {
      return;
    }
    this.queueWorkspaceAutoUpdate(state, reason);
  }

  private handleSearchExcludeConfigurationChanges(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('search.exclude')) {
      return;
    }

    for (const state of this.states.values()) {
      if (!this.isWorkspaceInitialized(state)) {
        continue;
      }
      if (!event.affectsConfiguration('search.exclude', state.folder.uri)) {
        continue;
      }
      this.queueWorkspaceSearchExcludeSync(state);
    }
  }

  private shouldQueueAutoUpdateForUri(state: WorkspaceQgrepState, uri: vscode.Uri): boolean {
    if (this.disposed) {
      return false;
    }
    if (this.states.get(state.key) !== state) {
      return false;
    }
    if (!state.fsWatcher) {
      return false;
    }
    if (!this.isWorkspaceInitialized(state)) {
      return false;
    }

    const targetPath = path.resolve(uri.fsPath);
    if (!isPathInsideRoot(state.folder.uri.fsPath, targetPath)) {
      return false;
    }
    if (isPathInsideRoot(state.qgrepDirPath, targetPath)) {
      return false;
    }
    return true;
  }

  private queueWorkspaceAutoUpdate(state: WorkspaceQgrepState, reason: 'create' | 'delete'): void {
    const shouldLogQueuedReason = state.pendingCreateDeleteCount === 0;
    state.autoUpdateDirty = true;
    state.pendingCreateDeleteCount += 1;
    if (shouldLogQueuedReason) {
      qgrepLogger.info(`[qgrep.autoupdate:${state.folder.name}] queued ${reason}`);
    }
    this.scheduleWorkspaceAutoUpdate(state, AUTO_UPDATE_DEBOUNCE_MS);
  }

  private queueWorkspaceSearchExcludeSync(state: WorkspaceQgrepState): void {
    if (this.disposed || this.states.get(state.key) !== state) {
      return;
    }
    if (!this.isWorkspaceInitialized(state)) {
      return;
    }
    state.managedSearchExcludeDirty = true;
    state.autoUpdateDirty = true;
    qgrepLogger.info(`[qgrep.exclude-sync:${state.folder.name}] queued search.exclude sync`);
    this.scheduleWorkspaceAutoUpdate(state, SEARCH_EXCLUDE_SYNC_DEBOUNCE_MS);
  }

  private scheduleWorkspaceAutoUpdate(state: WorkspaceQgrepState, delayMs: number): void {
    if (this.disposed || this.states.get(state.key) !== state) {
      return;
    }
    if (state.autoUpdateTimer) {
      clearTimeout(state.autoUpdateTimer);
    }
    state.autoUpdateTimer = setTimeout(() => {
      state.autoUpdateTimer = undefined;
      void this.runQueuedWorkspaceAutoUpdate(state);
    }, Math.max(0, delayMs));
  }

  private async runQueuedWorkspaceAutoUpdate(state: WorkspaceQgrepState): Promise<void> {
    if (this.disposed || this.states.get(state.key) !== state) {
      return;
    }
    if (!state.autoUpdateDirty && !state.managedSearchExcludeDirty && !isQgrepRecoveryActive(state)) {
      return;
    }
    if (state.autoUpdateInFlight) {
      return;
    }
    if (!this.isWorkspaceInitialized(state)) {
      state.autoUpdateDirty = false;
      state.pendingCreateDeleteCount = 0;
      state.managedSearchExcludeDirty = false;
      return;
    }
    if (state.progress.indexing) {
      this.scheduleWorkspaceAutoUpdate(state, AUTO_UPDATE_DEBOUNCE_MS);
      return;
    }

    const queuedCount = state.pendingCreateDeleteCount;
    const shouldSyncManagedSearchExclude = state.managedSearchExcludeDirty;
    const isStartupRefreshRun = state.startupRefreshPending;
    const recoveryPhase = state.recoveryPhase;
    state.startupRefreshPending = false;
    state.pendingCreateDeleteCount = 0;
    state.autoUpdateDirty = false;
    state.managedSearchExcludeDirty = false;
    state.autoUpdateInFlight = true;
    qgrepLogger.info(
      `[qgrep.autoupdate:${state.folder.name}] queued ${queuedCount} event(s)`
      + (shouldSyncManagedSearchExclude ? ' + search.exclude sync' : ''),
    );

    try {
      if (state.recoveryPhase === 'fallback-rebuild') {
        qgrepLogger.warn(`[qgrep.recovery:${state.folder.name}] switching to fallback rebuild`);
        state.watchWasRunningBeforeRebuild = state.watchProcess !== undefined;
        await this.rebuildWorkspace(state);
        this.resetWorkspaceRecovery(state);
        qgrepLogger.info(`[qgrep.recovery:${state.folder.name}] fallback rebuild done`);
      } else {
        const outcome = await this.autoUpdateWorkspace(state, shouldSyncManagedSearchExclude);
        if (outcome === 'done') {
          this.resetWorkspaceRecovery(state);
          qgrepLogger.info(`[qgrep.autoupdate:${state.folder.name}] update done`);
        }
      }
    } catch (error) {
      const errorSummary = String(error);
      qgrepLogger.warn(`[qgrep.autoupdate:${state.folder.name}] update failed: ${errorSummary}`);
      if (recoveryPhase === 'fallback-rebuild') {
        const recoveryClass = this.classifyRecoveryFailure(error, 'rebuild');
        this.applyWorkspaceDegradedState(state, errorSummary, recoveryClass === 'recoverable');
        if (state.watchWasRunningBeforeRebuild && !this.disposed && this.isWorkspaceInitialized(state)) {
          this.startWatch(state);
        }
        this.ensureAutoUpdateWatcher(state);
      } else {
        const restoredQueueState = restoreQgrepAutoUpdateQueueAfterFailure(
          {
            startupRefreshPending: state.startupRefreshPending,
            autoUpdateDirty: state.autoUpdateDirty,
            managedSearchExcludeDirty: state.managedSearchExcludeDirty,
            pendingCreateDeleteCount: state.pendingCreateDeleteCount,
          },
          queuedCount,
          shouldSyncManagedSearchExclude,
          isStartupRefreshRun,
        );
        state.startupRefreshPending = restoredQueueState.startupRefreshPending;
        state.autoUpdateDirty = restoredQueueState.autoUpdateDirty;
        state.managedSearchExcludeDirty = restoredQueueState.managedSearchExcludeDirty;
        state.pendingCreateDeleteCount = restoredQueueState.pendingCreateDeleteCount;
        if (this.classifyRecoveryFailure(error, 'update') === 'recoverable') {
          const delayMs = this.beginRecoverableUpdateRetry(state, errorSummary);
          if (!this.disposed) {
            this.scheduleWorkspaceAutoUpdate(state, delayMs);
          }
        } else {
          this.applyWorkspaceDegradedState(state, errorSummary, false);
        }
      }
      if (isStartupRefreshRun && recoveryPhase !== 'fallback-rebuild') {
        await this.tryStartupAutoRepair(state, error);
      }
    } finally {
      state.autoUpdateInFlight = false;
    }
  }

  private async autoUpdateWorkspace(
    state: WorkspaceQgrepState,
    shouldSyncManagedSearchExclude = false,
  ): Promise<'done' | 'cancelled'> {
    let cancelledByClear = false;
    await this.runWorkspaceIndexOperationExclusive(state, async () => {
      if (this.disposed || !this.isWorkspaceInitialized(state)) {
        return;
      }

      qgrepLogger.info(`[qgrep.autoupdate:${state.folder.name}] update start`);
      this.stopWatch(state);
      this.setWorkspaceIndexing(state, true);

      try {
        if (shouldSyncManagedSearchExclude) {
          await this.syncManagedSearchExcludeBlock(state);
        }
        const updateResult = await this.runWorkspaceIndexCommand(
          state,
          'update',
          ['update', state.configPath],
          state.folder.uri.fsPath,
          { progressState: state },
        );
        if (updateResult.cancelledByClear) {
          this.logIndexCommandCancelledDuringClear(state, 'autoupdate', 'update');
          cancelledByClear = true;
          return;
        }
        const updateError = this.extractCommandError(updateResult.command, `Auto update failed for workspace '${state.folder.name}'.`);
        if (updateError) {
          throw new Error(updateError);
        }
        this.finalizeWorkspaceProgressAfterSuccessfulIndexCommand(state);
      } finally {
        this.setWorkspaceIndexing(state, false);
        if (!this.disposed && this.isWorkspaceInitialized(state)) {
          this.startWatch(state);
        }
      }
    });
    return cancelledByClear ? 'cancelled' : 'done';
  }

  private async tryStartupAutoRepair(state: WorkspaceQgrepState, error: unknown): Promise<void> {
    if (!this.isCorruptIndexAssertionError(error)) {
      qgrepLogger.info(`[qgrep.startup-repair:${state.folder.name}] skip non-corruption error`);
      return;
    }
    if (state.startupAutoRepairAttempted) {
      qgrepLogger.info(`[qgrep.startup-repair:${state.folder.name}] skip already attempted`);
      return;
    }
    if (this.disposed || this.states.get(state.key) !== state || !this.isWorkspaceInitialized(state)) {
      qgrepLogger.info(`[qgrep.startup-repair:${state.folder.name}] skip workspace no longer available`);
      return;
    }

    state.startupAutoRepairAttempted = true;
    qgrepLogger.warn(`[qgrep.startup-repair:${state.folder.name}] trigger assertion signature detected; rebuilding index`);
    try {
      await this.rebuildWorkspace(state);
      qgrepLogger.info(`[qgrep.startup-repair:${state.folder.name}] success rebuild completed`);
    } catch (rebuildError) {
      qgrepLogger.warn(`[qgrep.startup-repair:${state.folder.name}] fail ${String(rebuildError)}`);
    }
  }

  private isCorruptIndexAssertionError(error: unknown): boolean {
    const message = String(error).toLowerCase();
    if (!message.includes('assertion failed')) {
      return false;
    }
    return message.includes('filter.cpp') || message.includes('entries.entries');
  }

  private async syncManagedSearchExcludeBlock(state: WorkspaceQgrepState): Promise<void> {
    if (this.disposed || !this.isWorkspaceInitialized(state)) {
      return;
    }

    let rawConfigText: string;
    try {
      rawConfigText = await fs.promises.readFile(state.configPath, 'utf8');
    } catch (error) {
      throw new Error(`Failed to read qgrep config '${state.configPath}': ${String(error)}`);
    }

    const shaderIncludeBuildResult = this.buildManagedShaderIncludeBlock();
    const powershellIncludeBuildResult = this.buildManagedPowerShellIncludeBlock();
    const excludeBuildResult = this.buildManagedSearchExcludeBlock(state.folder);
    for (const warning of excludeBuildResult.warnings) {
      qgrepLogger.warn(`[qgrep.exclude-sync:${state.folder.name}] ${warning}`);
    }

    const normalizedInput = normalizeLineEndings(rawConfigText);
    const normalizedWithCurrentWorkspacePath = upsertWorkspaceConfigPathLine(
      normalizedInput,
      state.folder.uri.fsPath,
    );
    const shaderIncludeUpsertResult = upsertManagedConfigBlock(
      normalizedWithCurrentWorkspacePath,
      shaderIncludeBuildResult.blockTextNormalized,
      QGREP_MANAGED_SHADER_INCLUDE_BLOCK_BEGIN,
      QGREP_MANAGED_SHADER_INCLUDE_BLOCK_END,
    );
    const powershellIncludeUpsertResult = upsertManagedConfigBlock(
      shaderIncludeUpsertResult.textNormalized,
      powershellIncludeBuildResult.blockTextNormalized,
      QGREP_MANAGED_POWERSHELL_INCLUDE_BLOCK_BEGIN,
      QGREP_MANAGED_POWERSHELL_INCLUDE_BLOCK_END,
    );
    const excludeUpsertResult = upsertManagedConfigBlock(
      powershellIncludeUpsertResult.textNormalized,
      excludeBuildResult.blockTextNormalized,
      QGREP_MANAGED_SEARCH_EXCLUDE_BLOCK_BEGIN,
      QGREP_MANAGED_SEARCH_EXCLUDE_BLOCK_END,
    );
    if (shaderIncludeUpsertResult.malformedBlockDetected) {
      qgrepLogger.warn(
        `[qgrep.exclude-sync:${state.folder.name}] malformed managed shader include block markers detected; appended a new managed block at file end.`,
      );
    }
    if (powershellIncludeUpsertResult.malformedBlockDetected) {
      qgrepLogger.warn(
        `[qgrep.exclude-sync:${state.folder.name}] malformed managed powershell include block markers detected; appended a new managed block at file end.`,
      );
    }
    if (excludeUpsertResult.malformedBlockDetected) {
      qgrepLogger.warn(
        `[qgrep.exclude-sync:${state.folder.name}] malformed managed search.exclude block markers detected; appended a new managed block at file end.`,
      );
    }
    if (excludeUpsertResult.textNormalized === normalizedInput) {
      return;
    }

    const lineEnding = detectLineEnding(rawConfigText);
    const outputText = restoreLineEndings(excludeUpsertResult.textNormalized, lineEnding);
    qgrepLogger.info(`[qgrep.exclude-sync:${state.folder.name}] writing managed qgrep config blocks`);
    try {
      await fs.promises.writeFile(state.configPath, outputText, 'utf8');
    } catch (error) {
      throw new Error(`Failed to write qgrep config '${state.configPath}': ${String(error)}`);
    }
    qgrepLogger.info(
      `[qgrep.exclude-sync:${state.folder.name}] wrote ${String(shaderIncludeBuildResult.includeRuleCount)} shader include rule(s), ${String(powershellIncludeBuildResult.includeRuleCount)} powershell include rule(s), and ${String(excludeBuildResult.excludeRuleCount)} exclude rule(s)`,
    );
  }

  private buildManagedShaderIncludeBlock(): {
    blockTextNormalized: string;
    includeRuleCount: number;
  } {
    const lines: string[] = [
      QGREP_MANAGED_SHADER_INCLUDE_BLOCK_BEGIN,
      QGREP_MANAGED_SHADER_INCLUDE_SOURCE_COMMENT,
      `include ${QGREP_MANAGED_SHADER_INCLUDE_RULE}`,
      QGREP_MANAGED_SHADER_INCLUDE_BLOCK_END,
    ];

    return {
      blockTextNormalized: lines.join('\n'),
      includeRuleCount: 1,
    };
  }

  private buildManagedPowerShellIncludeBlock(): {
    blockTextNormalized: string;
    includeRuleCount: number;
  } {
    const lines: string[] = [
      QGREP_MANAGED_POWERSHELL_INCLUDE_BLOCK_BEGIN,
      QGREP_MANAGED_POWERSHELL_INCLUDE_SOURCE_COMMENT,
      `include ${QGREP_MANAGED_POWERSHELL_INCLUDE_RULE}`,
      QGREP_MANAGED_POWERSHELL_INCLUDE_BLOCK_END,
    ];

    return {
      blockTextNormalized: lines.join('\n'),
      includeRuleCount: 1,
    };
  }

  private buildManagedSearchExcludeBlock(folder: vscode.WorkspaceFolder): {
    blockTextNormalized: string;
    warnings: string[];
    excludeRuleCount: number;
  } {
    const warnings: string[] = [];
    const patterns = this.readEffectiveSearchExcludeTruePatterns(folder);
    const convertedRules: string[] = [];
    for (const pattern of patterns) {
      const converted = convertSearchExcludeGlobToQgrepExcludeRegex(pattern);
      if (!converted) {
        warnings.push(`unsupported search.exclude pattern skipped: ${pattern}`);
        continue;
      }
      convertedRules.push(converted);
    }

    convertedRules.sort((left, right) => left.localeCompare(right));
    const seenRules = new Set<string>();
    const orderedRules: string[] = [];
    for (const fixedRule of QGREP_FIXED_EXCLUDE_REGEXES) {
      seenRules.add(fixedRule);
      orderedRules.push(fixedRule);
    }
    for (const convertedRule of convertedRules) {
      if (seenRules.has(convertedRule)) {
        continue;
      }
      seenRules.add(convertedRule);
      orderedRules.push(convertedRule);
    }

    const lines: string[] = [
      QGREP_MANAGED_SEARCH_EXCLUDE_BLOCK_BEGIN,
      QGREP_MANAGED_SEARCH_EXCLUDE_SOURCE_COMMENT,
    ];
    if (orderedRules.length === 0) {
      lines.push(QGREP_MANAGED_SEARCH_EXCLUDE_EMPTY_COMMENT);
    } else {
      for (const rule of orderedRules) {
        lines.push(`exclude ${rule}`);
      }
    }
    lines.push(QGREP_MANAGED_SEARCH_EXCLUDE_BLOCK_END);

    return {
      blockTextNormalized: lines.join('\n'),
      warnings,
      excludeRuleCount: orderedRules.length,
    };
  }

  private readEffectiveSearchExcludeTruePatterns(folder: vscode.WorkspaceFolder): string[] {
    const workspaceConfig = vscode.workspace.getConfiguration('search');
    const workspaceExclude = workspaceConfig.get<Record<string, unknown>>('exclude', {});
    const folderConfig = vscode.workspace.getConfiguration('search', folder.uri);
    const folderExclude = folderConfig.get<Record<string, unknown>>('exclude', {});
    const merged = {
      ...(isPlainRecord(workspaceExclude) ? workspaceExclude : {}),
      ...(isPlainRecord(folderExclude) ? folderExclude : {}),
    };

    const patterns: string[] = [];
    for (const [rawPattern, value] of Object.entries(merged)) {
      if (value !== true) {
        continue;
      }
      const normalized = normalizeSearchExcludeGlob(rawPattern);
      if (!normalized) {
        continue;
      }
      patterns.push(normalized);
    }

    patterns.sort((left, right) => left.localeCompare(right));
    return patterns;
  }

  private async initWorkspace(state: WorkspaceQgrepState): Promise<void> {
    await this.runWorkspaceIndexOperationExclusive(state, async () => {
      await this.initWorkspaceInternal(state);
    });
  }

  private async initWorkspaceInternal(state: WorkspaceQgrepState): Promise<void> {
    this.requireBinaryPath();
    await fs.promises.mkdir(state.qgrepDirPath, { recursive: true });
    this.setWorkspaceIndexing(state, true);

    try {
      if (!this.isWorkspaceInitialized(state)) {
        const initResult = await this.runWorkspaceIndexCommand(
          state,
          'init',
          ['init', state.configPath, state.folder.uri.fsPath],
          state.folder.uri.fsPath,
          { progressState: state },
        );
        if (initResult.cancelledByClear) {
          this.logIndexCommandCancelledDuringClear(state, 'init', 'init');
          return;
        }
        const initError = this.extractCommandError(initResult.command, `Init failed for workspace '${state.folder.name}'.`);
        if (initError) {
          throw new Error(initError);
        }
      }

      await this.syncManagedSearchExcludeBlock(state);

      const updateResult = await this.runWorkspaceIndexCommand(
        state,
        'update',
        ['update', state.configPath],
        state.folder.uri.fsPath,
        { progressState: state },
      );
      if (updateResult.cancelledByClear) {
        this.logIndexCommandCancelledDuringClear(state, 'init', 'update');
        return;
      }
      const updateError = this.extractCommandError(updateResult.command, `Update failed for workspace '${state.folder.name}'.`);
      if (updateError) {
        throw new Error(updateError);
      }
      this.finalizeWorkspaceProgressAfterSuccessfulIndexCommand(state);
      this.resetWorkspaceRecovery(state);

      this.stopWatch(state);
      this.startWatch(state);
      this.ensureAutoUpdateWatcher(state);
    } catch (error) {
      const recoveryClass = this.classifyRecoveryFailure(error, 'init-update');
      if (this.isWorkspaceInitialized(state) && recoveryClass === 'recoverable') {
        state.autoUpdateDirty = true;
        const delayMs = this.beginRecoverableUpdateRetry(state, String(error));
        if (!this.disposed) {
          this.scheduleWorkspaceAutoUpdate(state, delayMs);
        }
      } else {
        this.applyWorkspaceDegradedState(state, String(error), false);
      }
      this.markWorkspaceIndexingFailed(state);
      throw error;
    } finally {
      this.setWorkspaceIndexing(state, false);
    }
  }

  private async rebuildWorkspace(state: WorkspaceQgrepState): Promise<void> {
    await this.runWorkspaceIndexOperationExclusive(state, async () => {
      await this.rebuildWorkspaceInternal(state);
    });
  }

  private async rebuildWorkspaceInternal(state: WorkspaceQgrepState): Promise<void> {
    this.requireBinaryPath();
    await fs.promises.mkdir(state.qgrepDirPath, { recursive: true });
    state.watchWasRunningBeforeRebuild = state.watchProcess !== undefined;
    this.stopWatch(state);
    this.setWorkspaceIndexing(state, true);

    try {
      if (!this.isWorkspaceInitialized(state)) {
        const initResult = await this.runWorkspaceIndexCommand(
          state,
          'init',
          ['init', state.configPath, state.folder.uri.fsPath],
          state.folder.uri.fsPath,
          { progressState: state },
        );
        if (initResult.cancelledByClear) {
          this.logIndexCommandCancelledDuringClear(state, 'rebuild', 'init');
          return;
        }
        const initError = this.extractCommandError(initResult.command, `Init failed for workspace '${state.folder.name}'.`);
        if (initError) {
          throw new Error(initError);
        }
      }

      await this.syncManagedSearchExcludeBlock(state);

      const buildResult = await this.runWorkspaceIndexCommand(
        state,
        'build',
        ['build', state.configPath],
        state.folder.uri.fsPath,
        { progressState: state },
      );
      if (buildResult.cancelledByClear) {
        this.logIndexCommandCancelledDuringClear(state, 'rebuild', 'build');
        return;
      }
      const buildError = this.extractCommandError(buildResult.command, `Build failed for workspace '${state.folder.name}'.`);
      if (buildError) {
        throw new Error(buildError);
      }
      this.finalizeWorkspaceProgressAfterSuccessfulIndexCommand(state);
      this.resetWorkspaceRecovery(state);

      this.startWatch(state);
      this.ensureAutoUpdateWatcher(state);
    } catch (error) {
      if (state.watchWasRunningBeforeRebuild && !this.disposed && this.isWorkspaceInitialized(state)) {
        this.startWatch(state);
      }
      this.markWorkspaceIndexingFailed(state);
      throw error;
    } finally {
      this.setWorkspaceIndexing(state, false);
    }
  }

  private finalizeWorkspaceProgressAfterSuccessfulIndexCommand(state: WorkspaceQgrepState): void {
    const nextProgress = finalizeSuccessfulQgrepIndexProgress(state.progress);
    if (nextProgress === state.progress) {
      this.refreshStaleWatchHeartbeat(state);
      return;
    }
    state.progress = nextProgress;
    this.refreshStaleWatchHeartbeat(state);
    this.notifyStatusChanged();
  }

  private requireBinaryPath(): string {
    if (!fs.existsSync(this.binaryPath)) {
      throw new QgrepUnavailableError(`binary is missing at ${this.binaryPath}.`);
    }
    return this.binaryPath;
  }

  private async runQgrepCommand(
    args: string[],
    cwd: string,
    options?: QgrepCommandOptions,
  ): Promise<QgrepCommandResult> {
    const binaryPath = this.requireBinaryPath();
    return new Promise<QgrepCommandResult>((resolve, reject) => {
      const child = spawn(binaryPath, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const stdoutProgress = { pendingText: '' };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        if (options?.progressState) {
          this.consumeProgressStream(options.progressState, stdoutProgress, chunk.toString('utf8'));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on('error', (error) => {
        reject(error);
      });
      child.on('close', (code) => {
        if (options?.progressState) {
          this.flushProgressStream(options.progressState, stdoutProgress);
        }
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });
    });
  }

  private async runWorkspaceIndexCommand(
    state: WorkspaceQgrepState,
    kind: QgrepIndexCommandKind,
    args: string[],
    cwd: string,
    options?: QgrepCommandOptions,
  ): Promise<WorkspaceIndexCommandResult> {
    const binaryPath = this.requireBinaryPath();
    return new Promise<WorkspaceIndexCommandResult>((resolve, reject) => {
      const child = spawn(binaryPath, args, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      state.activeIndexCommandProcess = child;
      state.activeIndexCommandKind = kind;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const stdoutProgress = { pendingText: '' };
      let settled = false;

      const clearTracking = (): void => {
        if (state.activeIndexCommandProcess === child) {
          state.activeIndexCommandProcess = undefined;
          state.activeIndexCommandKind = undefined;
        }
        if (state.activeIndexCommandCancelledProcess === child) {
          state.activeIndexCommandCancelledProcess = undefined;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        if (options?.progressState) {
          this.consumeProgressStream(options.progressState, stdoutProgress, chunk.toString('utf8'));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTracking();
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        if (options?.progressState) {
          this.flushProgressStream(options.progressState, stdoutProgress);
        }
        const cancelledByClear = state.activeIndexCommandCancelledProcess === child;
        const command: QgrepCommandResult = {
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        };
        clearTracking();
        resolve({
          command,
          cancelledByClear,
        });
      });
    });
  }

  private extractCommandError(result: QgrepCommandResult, prefix: string): string | undefined {
    const stderrText = result.stderr.trim();
    const errorLine = stderrText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line.startsWith('Error'));

    if (result.exitCode !== 0) {
      const detail = errorLine ?? stderrText;
      return detail.length > 0 ? `${prefix} ${detail}` : `${prefix} qgrep exited with code ${String(result.exitCode)}.`;
    }
    if (errorLine) {
      return `${prefix} ${errorLine}`;
    }
    return undefined;
  }
}

let activeService: QgrepService | undefined;

export function setQgrepLogger(logger: QgrepLogger): void {
  qgrepLogger = logger;
}

export function setQgrepStatusChangeHandler(handler: QgrepStatusChangeHandler | undefined): void {
  qgrepStatusChangeHandler = handler;
}

export function activateQgrepService(context: vscode.ExtensionContext): vscode.Disposable {
  if (activeService) {
    activeService.dispose();
    activeService = undefined;
  }

  const binaryPath = context.asAbsolutePath(path.join('bin', 'qgrep.exe'));
  const service = new QgrepService(binaryPath);
  service.activate();
  activeService = service;

  return new vscode.Disposable(() => {
    if (activeService === service) {
      activeService = undefined;
    }
    service.dispose();
  });
}

export async function runQgrepInitAllWorkspacesCommand(): Promise<QgrepCommandSummary> {
  return requireQgrepService().initAllWorkspaces();
}

export async function runQgrepRebuildIndexesCommand(): Promise<QgrepCommandSummary> {
  return requireQgrepService().rebuildAllWorkspaces();
}

export async function runQgrepStopAndClearCommand(): Promise<QgrepCommandSummary> {
  return requireQgrepService().stopAndClearAllWorkspaces();
}

export async function executeQgrepSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requireQgrepService().search(input);
}

export async function executeQgrepFilesSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requireQgrepService().files(input);
}

export function getQgrepStatusSummary(): QgrepStatusSummary {
  if (activeService) {
    return activeService.getStatusSummary();
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaceStatuses = folders
    .map((folder) => {
      return {
        workspaceName: folder.name,
        initialized: false,
        watching: false,
        ready: false,
        progressKnown: false,
        indexing: false,
      };
    })
    .sort((left, right) => left.workspaceName.localeCompare(right.workspaceName));

  return {
    binaryPath: '',
    binaryAvailable: false,
    totalWorkspaces: workspaceStatuses.length,
    initializedWorkspaces: 0,
    watchingWorkspaces: 0,
    workspaceStatuses,
  };
}

function requireQgrepService(): QgrepService {
  if (activeService) {
    return activeService;
  }
  throw new Error('Qgrep service is not initialized.');
}

function splitIntoCompletedLines(
  pendingText: string,
  incomingText: string,
): { lines: string[]; remainder: string } {
  const merged = `${pendingText}${incomingText}`
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const parts = merged.split('\n');
  const remainder = parts.pop() ?? '';
  return {
    lines: parts,
    remainder,
  };
}

function parseQgrepResultSummary(stdout: string): ParsedQgrepResultSummary {
  const lines = stdout.split(/\r?\n/u);
  let summary: ParsedQgrepResultSummary = { capped: false };
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = QGREP_SUMMARY_PATTERN.exec(line.trim());
    if (!match) {
      continue;
    }
    const totalMatches = Number(match[1]);
    summary = {
      totalMatches: Number.isFinite(totalMatches) ? totalMatches : undefined,
      capped: match[2] === '+',
    };
  }
  return summary;
}

function isQgrepSummaryLine(line: string): boolean {
  return QGREP_SUMMARY_PATTERN.test(line.trim());
}

function isAbsolutePath(inputPath: string): boolean {
  return path.isAbsolute(inputPath) || startsWithWindowsAbsolutePath(inputPath);
}

function startsWithWindowsAbsolutePath(inputPath: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(inputPath) || inputPath.startsWith('\\\\');
}

function normalizeForComparison(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeSlash(inputPath: string): string {
  return inputPath.replace(/\\/g, '/');
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const root = normalizeForComparison(rootPath);
  const target = normalizeForComparison(targetPath);
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function encodeRegexForQgrepSearchOption(regexSource: string): string {
  let encoded = '';
  for (const char of regexSource) {
    if (char === ' ') {
      encoded += '\\x20';
      continue;
    }
    if (char === '\t') {
      encoded += '\\x09';
      continue;
    }
    if (char === '\n') {
      encoded += '\\x0a';
      continue;
    }
    if (char === '\r') {
      encoded += '\\x0d';
      continue;
    }
    encoded += char;
  }
  return encoded;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function detectLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function restoreLineEndings(textNormalized: string, lineEnding: '\r\n' | '\n'): string {
  if (lineEnding === '\n') {
    return textNormalized;
  }
  return textNormalized.replace(/\n/g, '\r\n');
}

function delayMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, durationMs));
  });
}

function compileWorkspaceGlobPathMatcher(pattern: string): QgrepGlobPathMatcher {
  const normalizedPattern = normalizeWorkspaceSearchGlobPattern(pattern);
  if (normalizedPattern.length === 0) {
    throw new Error('pathScope glob must be a non-empty string.');
  }

  let glob = normalizedPattern.startsWith('/') ? normalizedPattern.slice(1) : normalizedPattern;
  if (glob.length === 0) {
    glob = '**/*';
  }

  const regexSource = compileWorkspaceGlobToRegexSource(glob);
  const fullSource = `^${regexSource}$`;
  const flags = process.platform === 'win32' ? 'iu' : 'u';

  try {
    const regex = new RegExp(fullSource, flags);
    return {
      pattern: normalizedPattern,
      pathRegexSource: regexSource,
      regex,
      matchTarget: 'relative',
    };
  } catch (error) {
    throw new Error(`Invalid pathScope glob pattern: ${String(error)}`);
  }
}

function compileAbsoluteGlobPathMatcher(pattern: string): QgrepGlobPathMatcher {
  const normalizedPattern = normalizeWorkspaceSearchGlobPattern(pattern);
  if (!isAbsolutePath(normalizedPattern)) {
    throw new Error(`pathScope glob must be an absolute path pattern: ${pattern}`);
  }

  const regexSource = compileWorkspaceGlobToRegexSource(normalizedPattern);
  const fullSource = `^${regexSource}$`;
  const flags = process.platform === 'win32' ? 'iu' : 'u';

  try {
    const regex = new RegExp(fullSource, flags);
    return {
      pattern: normalizedPattern,
      pathRegexSource: regexSource,
      regex,
      matchTarget: 'absolute',
    };
  } catch (error) {
    throw new Error(`Invalid pathScope glob pattern: ${String(error)}`);
  }
}

function compileWorkspaceGlobToRegexSource(glob: string): string {
  return compileGlobToRegexSource(glob, 'pathScope glob pattern');
}

function normalizeSearchExcludeGlob(pattern: string): string | undefined {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const normalized = normalizeSlash(trimmed)
    .replace(/^\.\//u, '')
    .replace(/\/{2,}/g, '/');
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Validates regex syntax intended for qgrep workspace.cfg include/exclude rules.
 * qgrep uses RE2 with POSIX syntax restrictions for project config regexes, so
 * Perl-style look-around and non-capturing groups must not be emitted.
 *
 * @param regexSource Regex source string that will be written to workspace.cfg.
 * @returns An error reason when unsupported syntax is detected; otherwise undefined.
 */
function validateQgrepConfigRegexSyntax(regexSource: string): string | undefined {
  if (regexSource.includes('(?:')) {
    return 'non-capturing groups (?:...) are not supported';
  }
  if (regexSource.includes('(?=')) {
    return 'positive look-ahead (?=...) is not supported';
  }
  if (regexSource.includes('(?!')) {
    return 'negative look-ahead (?!...) is not supported';
  }
  if (regexSource.includes('(?<=')) {
    return 'positive look-behind (?<=...) is not supported';
  }
  if (regexSource.includes('(?<!')) {
    return 'negative look-behind (?<!...) is not supported';
  }
  if (regexSource.includes('(?<')) {
    return 'named groups or extended (?<...) syntax is not supported';
  }
  return undefined;
}

/**
 * Converts a VS Code search.exclude glob pattern into a qgrep-safe exclude regex.
 * The supported glob subset is intentionally limited to *, ?, **, and / so the
 * generated regex stays compatible with qgrep workspace.cfg parsing.
 * Unsupported patterns are skipped by returning undefined.
 *
 * @param pattern VS Code search.exclude glob pattern.
 * @returns qgrep-safe regex source for workspace.cfg exclude rules, or undefined when unsupported.
 */
function convertSearchExcludeGlobToQgrepExcludeRegex(pattern: string): string | undefined {
  const normalized = normalizeSearchExcludeGlob(pattern);
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('!')) {
    return undefined;
  }
  if (/[{}\[\]]/u.test(normalized)) {
    return undefined;
  }

  const anchored = normalized.startsWith('/');
  let glob = anchored ? normalized.slice(1) : normalized;
  if (glob.length === 0) {
    return undefined;
  }
  if (glob.endsWith('/')) {
    glob = `${glob}**`;
  }

  const hasSlash = glob.includes('/');
  const regexSource = compileSimpleGlobToRegexSource(glob);
  if (!regexSource) {
    return undefined;
  }
  const finalRegex = !hasSlash && !anchored
    ? `(^|.*/)${regexSource}(/.*)?$`
    : `^${regexSource}(/.*)?$`;
  if (validateQgrepConfigRegexSyntax(finalRegex)) {
    return undefined;
  }
  return finalRegex;
}

/**
 * Compiles a restricted glob subset into a regex source fragment used by qgrep
 * workspace.cfg exclude rules. This function must not emit qgrep-incompatible
 * constructs such as non-capturing groups or look-around.
 *
 * @param glob Normalized glob pattern using '/' separators.
 * @returns Regex source fragment, or undefined when the input is empty.
 */
function compileSimpleGlobToRegexSource(glob: string): string | undefined {
  if (glob.length === 0) {
    return undefined;
  }

  let result = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        let endIndex = index + 1;
        while (glob[endIndex + 1] === '*') {
          endIndex += 1;
        }
        index = endIndex;
        if (glob[index + 1] === '/') {
          result += '(.*/)?';
          index += 1;
        } else {
          result += '.*';
        }
        continue;
      }
      result += '[^/]*';
      continue;
    }
    if (char === '?') {
      result += '[^/]';
      continue;
    }
    result += escapeRegex(char);
  }

  return result;
}

function upsertManagedConfigBlock(
  textNormalized: string,
  blockTextNormalized: string,
  blockBeginMarker: string,
  blockEndMarker: string,
): { textNormalized: string; malformedBlockDetected: boolean } {
  const hasFinalNewline = textNormalized.endsWith('\n');
  const body = hasFinalNewline ? textNormalized.slice(0, -1) : textNormalized;
  const lines = body.length > 0 ? body.split('\n') : [];

  const beginIndexes = findLineIndexes(lines, blockBeginMarker);
  const endIndexes = findLineIndexes(lines, blockEndMarker);
  const blockLines = blockTextNormalized.split('\n');
  let malformedBlockDetected = false;

  if (beginIndexes.length > 0 && endIndexes.length > 0) {
    const beginIndex = beginIndexes[0];
    const endIndex = endIndexes.find((index) => index >= beginIndex);
    if (endIndex !== undefined) {
      malformedBlockDetected = beginIndexes.length !== 1 || endIndexes.length !== 1;
      lines.splice(beginIndex, endIndex - beginIndex + 1, ...blockLines);
      const nextBody = lines.join('\n');
      return {
        textNormalized: hasFinalNewline ? `${nextBody}\n` : nextBody,
        malformedBlockDetected,
      };
    }
    malformedBlockDetected = true;
  } else if (beginIndexes.length > 0 || endIndexes.length > 0) {
    malformedBlockDetected = true;
  }

  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    lines.push('');
  }
  lines.push(...blockLines);
  const nextBody = lines.join('\n');
  return {
    textNormalized: hasFinalNewline ? `${nextBody}\n` : nextBody,
    malformedBlockDetected,
  };
}

function findLineIndexes(lines: readonly string[], expected: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === expected) {
      indexes.push(index);
    }
  }
  return indexes;
}
