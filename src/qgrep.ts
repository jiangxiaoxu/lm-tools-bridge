import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const QGREP_DIR_NAME = 'qgrep';
const QGREP_CONFIG_FILE_NAME = 'workspace.cfg';
const WATCH_RESTART_DELAY_MS = 1000;
const AUTO_UPDATE_DEBOUNCE_MS = 2000;
const SEARCH_EXCLUDE_SYNC_DEBOUNCE_MS = 500;
const TOOL_SEARCH_READY_TIMEOUT_MS = 150_000;
const TOOL_SEARCH_READY_POLL_INTERVAL_MS = 200;
const DEFAULT_MAX_RESULTS = 300;
const MIN_MAX_RESULTS = 1;
const QGREP_HARD_OUTPUT_LIMIT = 10000;
const INIT_COMMAND_HINT = 'Run "LM Tools Bridge: Qgrep Init All Workspaces" first.';
const QGREP_PROGRESS_FRAME_PATTERN = /\[\s*(\d{1,3})%\]\s+(\d+)\s+files\b/u;
const QGREP_SUMMARY_PATTERN = /^Search complete,\s+found\s+(\d+)(\+)?\s+(?:matches?|files?)\s+in\b/iu;
const QGREP_FILES_MODE_VALUES = ['fp', 'fn', 'fs', 'ff'] as const;
/**
 * These patterns run in Node.js only while parsing qgrep command output.
 * They are not written into qgrep workspace.cfg, so JS regex syntax features
 * such as non-capturing groups are allowed here.
 */
const QGREP_FILES_SCORE_PREFIX_TAB_PATTERN = /^([+-]?\d+(?:\.\d+)?)\t(.+)$/u;
const QGREP_FILES_SCORE_PREFIX_SPACE_PATTERN = /^([+-]?\d+(?:\.\d+)?)\s+(.+)$/u;
const QGREP_MANAGED_SEARCH_EXCLUDE_BLOCK_BEGIN = '# BEGIN lm-tools-bridge managed search.exclude';
const QGREP_MANAGED_SEARCH_EXCLUDE_BLOCK_END = '# END lm-tools-bridge managed search.exclude';
const QGREP_MANAGED_SEARCH_EXCLUDE_SOURCE_COMMENT = '# source: VS Code search.exclude (true entries only)';
const QGREP_MANAGED_SEARCH_EXCLUDE_EMPTY_COMMENT = '# no eligible search.exclude=true patterns';
const QGREP_MANAGED_SHADER_INCLUDE_BLOCK_BEGIN = '# BEGIN lm-tools-bridge managed shader include';
const QGREP_MANAGED_SHADER_INCLUDE_BLOCK_END = '# END lm-tools-bridge managed shader include';
const QGREP_MANAGED_SHADER_INCLUDE_SOURCE_COMMENT = '# source: lm-tools-bridge Unreal Engine include set (*.ush, *.usf, *.ini)';
const QGREP_MANAGED_SHADER_INCLUDE_RULE = '\\.(ush|usf|ini)$';
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
  indexedFiles?: number;
  totalFiles?: number;
  remainingFiles?: number;
  progressPercent?: number;
  progressKnown: boolean;
  indexing: boolean;
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
  regex: RegExp;
  matchTarget: 'relative' | 'absolute';
}

interface QgrepGlobSearchTarget {
  state: WorkspaceQgrepState;
  matcher: QgrepGlobPathMatcher;
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

type QgrepFilesMode = typeof QGREP_FILES_MODE_VALUES[number];

interface ParsedQgrepFile {
  absolutePath: string;
}

interface WorkspaceSearchResult {
  matches: ParsedQgrepMatch[];
  totalAvailableCapped: boolean;
}

interface WorkspaceFilesResult {
  files: ParsedQgrepFile[];
  totalAvailableCapped: boolean;
}

interface MaxResultsPayload {
  maxResultsApplied: number;
  maxResultsRequested?: number;
}

class QgrepService implements vscode.Disposable {
  private readonly states = new Map<string, WorkspaceQgrepState>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  constructor(private readonly binaryPath: string) {}

  public activate(): void {
    this.syncWorkspaceStates(vscode.workspace.workspaceFolders ?? []);
    this.startWatchForInitializedWorkspaces();
    this.startAutoUpdateWatchersForInitializedWorkspaces();
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
        this.stopWatch(state);
        this.stopAutoUpdateWatcher(state);
        this.cancelWorkspaceIndexCommandForClear(state);
        await fs.promises.rm(state.qgrepDirPath, { recursive: true, force: true });
        this.resetWorkspaceProgress(state);
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
    const searchPath = this.parseOptionalSearchPath(input);
    const maxResults = this.parseMaxResults(input);
    const maxResultsPayload = this.buildMaxResultsPayload(maxResults);
    const maxResultsApplied = maxResultsPayload.maxResultsApplied;
    const useCaseInsensitiveSearch = this.shouldUseCaseInsensitiveSearchForQuery(query);
    await this.ensureToolSearchReady();
    if (searchPath && this.isGlobSearchPath(searchPath)) {
      return this.searchWithGlobPath(searchPath, query, useCaseInsensitiveSearch, maxResultsPayload);
    }

    const targets = this.resolveSearchTargets(searchPath);
    if (targets.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const matches: Array<Record<string, unknown>> = [];
    let totalAvailable = 0;
    let totalAvailableCapped = false;
    let hardLimitHit = false;

    for (const target of targets) {
      const targetResult = await this.searchInWorkspace(target, query, useCaseInsensitiveSearch);
      totalAvailable += targetResult.matches.length;
      totalAvailableCapped = totalAvailableCapped || targetResult.totalAvailableCapped;
      hardLimitHit = hardLimitHit || targetResult.totalAvailableCapped;

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
      searchPath: searchPath ?? null,
      ...maxResultsPayload,
      totalAvailable,
      ...(totalAvailableCapped ? { totalAvailableCapped: true } : {}),
      ...(hardLimitHit ? { hardLimitHit: true } : {}),
      count: matches.length,
      capped,
      casePolicy: 'smart-case',
      caseModeApplied: useCaseInsensitiveSearch ? 'insensitive' : 'sensitive',
      matches,
    };
  }

  public async files(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = this.parseFilesQuery(input);
    const mode = this.parseFilesMode(input);
    const searchPath = this.parseOptionalSearchPath(input);
    const maxResults = this.parseMaxResults(input);
    const maxResultsPayload = this.buildMaxResultsPayload(maxResults);
    const maxResultsApplied = maxResultsPayload.maxResultsApplied;
    await this.ensureToolSearchReady();

    if (searchPath && this.isGlobSearchPath(searchPath)) {
      return this.filesWithGlobPath(searchPath, query, mode, maxResultsPayload);
    }

    const targets = this.resolveSearchTargets(searchPath);
    if (targets.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const files: Array<Record<string, unknown>> = [];
    let totalAvailable = 0;
    let totalAvailableCapped = false;
    let hardLimitHit = false;

    for (const target of targets) {
      const targetResult = await this.searchFilesInWorkspace(target, query, mode);
      totalAvailable += targetResult.files.length;
      totalAvailableCapped = totalAvailableCapped || targetResult.totalAvailableCapped;
      hardLimitHit = hardLimitHit || targetResult.totalAvailableCapped;

      if (files.length >= maxResultsApplied) {
        continue;
      }
      const remaining = maxResultsApplied - files.length;
      const selectedFiles = targetResult.files.slice(0, remaining);
      for (const file of selectedFiles) {
        files.push(this.toFilePayload(target.state.folder, file));
      }
    }

    const capped = totalAvailableCapped || files.length < totalAvailable;

    return {
      query,
      mode,
      searchPath: searchPath ?? null,
      ...maxResultsPayload,
      totalAvailable,
      ...(totalAvailableCapped ? { totalAvailableCapped: true } : {}),
      ...(hardLimitHit ? { hardLimitHit: true } : {}),
      count: files.length,
      capped,
      querySemanticsApplied: this.getFilesQuerySemantics(mode),
      sort: 'qgrep-native',
      files,
    };
  }

  private async filesWithGlobPath(
    searchPath: string,
    query: string,
    mode: QgrepFilesMode,
    maxResultsPayload: MaxResultsPayload,
  ): Promise<Record<string, unknown>> {
    const maxResultsApplied = maxResultsPayload.maxResultsApplied;
    const targets = this.resolveGlobSearchTargets(searchPath);
    if (targets.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const files: Array<Record<string, unknown>> = [];
    let totalAvailable = 0;
    let totalAvailableCapped = false;
    let hardLimitHit = false;

    for (const target of targets) {
      const targetResult = await this.searchFilesInWorkspace(
        { state: target.state },
        query,
        mode,
      );
      totalAvailableCapped = totalAvailableCapped || targetResult.totalAvailableCapped;
      hardLimitHit = hardLimitHit || targetResult.totalAvailableCapped;

      for (const file of targetResult.files) {
        if (!this.matchesGlobSearchPath(target.matcher, target.state.folder, file.absolutePath)) {
          continue;
        }
        totalAvailable += 1;
        if (files.length >= maxResultsApplied) {
          continue;
        }
        files.push(this.toFilePayload(target.state.folder, file));
      }
    }

    const capped = totalAvailableCapped || files.length < totalAvailable;

    return {
      query,
      mode,
      searchPath,
      ...maxResultsPayload,
      totalAvailable,
      ...(totalAvailableCapped ? { totalAvailableCapped: true } : {}),
      ...(hardLimitHit ? { hardLimitHit: true } : {}),
      count: files.length,
      capped,
      querySemanticsApplied: this.getFilesQuerySemantics(mode),
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
        indexedFiles: progress.indexedFiles,
        totalFiles: progress.totalFiles,
        remainingFiles: progress.remainingFiles,
        progressPercent: progress.progressPercent,
        progressKnown: progress.progressKnown,
        indexing: progress.indexing,
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
    this.notifyStatusChanged();
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
    state.autoUpdateDirty = true;
    qgrepLogger.info(`[qgrep.startup-update:${state.folder.name}] queued startup refresh`);
    this.scheduleWorkspaceAutoUpdate(state, 0);
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
      throw new Error('query must be a non-empty regex string.');
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

  private parseFilesMode(input: Record<string, unknown>): QgrepFilesMode {
    const value = input.mode;
    if (value === undefined || value === null) {
      return 'fp';
    }
    if (typeof value !== 'string') {
      throw new Error(`mode must be one of: ${QGREP_FILES_MODE_VALUES.join(', ')}.`);
    }
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      throw new Error(`mode must be one of: ${QGREP_FILES_MODE_VALUES.join(', ')}.`);
    }
    if (!QGREP_FILES_MODE_VALUES.includes(normalized as QgrepFilesMode)) {
      throw new Error(`mode must be one of: ${QGREP_FILES_MODE_VALUES.join(', ')}.`);
    }
    return normalized as QgrepFilesMode;
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

  private parseOptionalSearchPath(input: Record<string, unknown>): string | undefined {
    const value = input.searchPath;
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error('searchPath must be a string when provided.');
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error('searchPath must be a non-empty string when provided.');
    }
    return trimmed;
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

  private applyHardOutputLimit(maxResults: number): number {
    return Math.min(maxResults, QGREP_HARD_OUTPUT_LIMIT);
  }

  private buildMaxResultsPayload(maxResults: number): MaxResultsPayload {
    const maxResultsApplied = this.applyHardOutputLimit(maxResults);
    if (maxResults > maxResultsApplied) {
      return {
        maxResultsApplied,
        maxResultsRequested: maxResults,
      };
    }
    return { maxResultsApplied };
  }

  private getFilesQuerySemantics(mode: QgrepFilesMode):
    | 'fp-path-regex'
    | 'fn-name-regex'
    | 'fs-literal-components'
    | 'ff-fuzzy-path' {
    if (mode === 'fp') {
      return 'fp-path-regex';
    }
    if (mode === 'fn') {
      return 'fn-name-regex';
    }
    if (mode === 'fs') {
      return 'fs-literal-components';
    }
    return 'ff-fuzzy-path';
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

      if (!this.isWorkspaceInitialized(state)) {
        await this.initWorkspace(state);
        continue;
      }
      if (this.isWorkspaceReadyForToolSearch(state)) {
        return;
      }

      await delayMs(TOOL_SEARCH_READY_POLL_INTERVAL_MS);
    }
  }

  private isWorkspaceReadyForToolSearch(state: WorkspaceQgrepState): boolean {
    if (!this.isWorkspaceInitialized(state)) {
      return false;
    }
    if (state.pendingIndexOperationCount > 0) {
      return false;
    }
    if (state.autoUpdateInFlight) {
      return false;
    }
    if (state.progress.indexing) {
      return false;
    }
    if (state.progress.progressKnown) {
      const percent = state.progress.progressPercent ?? 0;
      return percent >= 100;
    }
    return true;
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
    const details = waitingStates.length > 0
      ? waitingStates
        .map((state) => `${state.folder.name}(${this.describeWorkspaceToolReadiness(state)})`)
        .join('; ')
      : 'unknown workspace state';
    return new Error(
      `Timed out after ${String(Math.floor(TOOL_SEARCH_READY_TIMEOUT_MS / 1000))}s waiting for qgrep indexing to become ready. `
      + `Use lm_qgrepGetStatus to inspect progress. Pending: ${details}.`,
    );
  }

  private describeWorkspaceToolReadiness(state: WorkspaceQgrepState): string {
    const parts: string[] = [];
    parts.push(`initialized=${String(this.isWorkspaceInitialized(state))}`);
    parts.push(`pendingOps=${String(state.pendingIndexOperationCount)}`);
    parts.push(`autoUpdateInFlight=${String(state.autoUpdateInFlight)}`);
    parts.push(`indexing=${String(state.progress.indexing)}`);
    parts.push(`progressKnown=${String(state.progress.progressKnown)}`);
    if (state.progress.progressPercent !== undefined) {
      parts.push(`progressPercent=${String(state.progress.progressPercent)}`);
    }
    return parts.join(', ');
  }

  private isGlobSearchPath(searchPath: string): boolean {
    const trimmed = searchPath.trim();
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

  private async searchWithGlobPath(
    searchPath: string,
    query: string,
    useCaseInsensitiveSearch: boolean,
    maxResultsPayload: MaxResultsPayload,
  ): Promise<Record<string, unknown>> {
    const maxResultsApplied = maxResultsPayload.maxResultsApplied;
    const targets = this.resolveGlobSearchTargets(searchPath);
    if (targets.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const matches: Array<Record<string, unknown>> = [];
    let totalAvailable = 0;
    let totalAvailableCapped = false;
    let hardLimitHit = false;

    for (const target of targets) {
      const targetResult = await this.searchInWorkspace(
        { state: target.state },
        query,
        useCaseInsensitiveSearch,
      );
      totalAvailableCapped = totalAvailableCapped || targetResult.totalAvailableCapped;
      hardLimitHit = hardLimitHit || targetResult.totalAvailableCapped;

      for (const match of targetResult.matches) {
        if (!this.matchesGlobSearchPath(target.matcher, target.state.folder, match.absolutePath)) {
          continue;
        }
        totalAvailable += 1;
        if (matches.length >= maxResultsApplied) {
          continue;
        }
        matches.push(this.toMatchPayload(target.state.folder, match));
      }
    }

    const capped = totalAvailableCapped || matches.length < totalAvailable;

    return {
      query,
      searchPath,
      ...maxResultsPayload,
      totalAvailable,
      ...(totalAvailableCapped ? { totalAvailableCapped: true } : {}),
      ...(hardLimitHit ? { hardLimitHit: true } : {}),
      count: matches.length,
      capped,
      casePolicy: 'smart-case',
      caseModeApplied: useCaseInsensitiveSearch ? 'insensitive' : 'sensitive',
      matches,
    };
  }

  private resolveGlobSearchTargets(searchPath: string): QgrepGlobSearchTarget[] {
    const trimmed = searchPath.trim();
    if (isAbsolutePath(trimmed)) {
      const matcher = compileAbsoluteGlobPathMatcher(trimmed);
      return this.getInitializedStates().map((state) => ({ state, matcher }));
    }

    const prefixed = this.tryResolveWorkspacePrefixedGlobPattern(trimmed);
    if (prefixed) {
      const state = this.requireInitializedState(prefixed.folder);
      const matcher = compileWorkspaceGlobPathMatcher(prefixed.pattern);
      return [{ state, matcher }];
    }

    const matcher = compileWorkspaceGlobPathMatcher(trimmed);
    return this.getInitializedStates().map((state) => ({ state, matcher }));
  }

  private resolveSearchTargets(searchPath: string | undefined): QgrepSearchTarget[] {
    if (!searchPath) {
      return this.getInitializedStates().map((state) => ({ state }));
    }
    const resolved = this.resolveSearchPath(searchPath);
    const filterRegex = this.buildFilterRegex(resolved.state.folder, resolved.absolutePath);
    return [{
      state: resolved.state,
      ...(filterRegex ? { filterRegex } : {}),
    }];
  }

  private resolveSearchPath(inputPath: string): ResolvedSearchPath {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new Error('No workspace folders are open.');
    }

    const trimmed = inputPath.trim();
    if (isAbsolutePath(trimmed)) {
      const absolutePath = path.resolve(trimmed);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`searchPath does not exist: ${inputPath}`);
      }
      const folder = this.findWorkspaceForAbsolutePath(absolutePath);
      if (!folder) {
        throw new Error(`searchPath is outside current workspaces: ${inputPath}`);
      }
      const state = this.requireInitializedState(folder);
      return { state, absolutePath };
    }

    const prefixed = this.tryResolveWorkspacePrefixedPath(trimmed);
    if (prefixed) {
      const absolutePath = path.resolve(prefixed.folder.uri.fsPath, prefixed.remainder);
      if (!isPathInsideRoot(prefixed.folder.uri.fsPath, absolutePath)) {
        throw new Error(`searchPath resolves outside workspace '${prefixed.folder.name}': ${inputPath}`);
      }
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`searchPath does not exist: ${inputPath}`);
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
      throw new Error(`searchPath was not found in current workspaces: ${inputPath}`);
    }
    if (matches.length > 1) {
      const candidates = matches.map((item) => item.folder.name).join(', ');
      throw new Error(`searchPath is ambiguous across workspaces (${candidates}). Use WorkspaceName/... form.`);
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

  private tryResolveWorkspacePrefixedGlobPattern(inputPath: string): {
    folder: vscode.WorkspaceFolder;
    pattern: string;
  } | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return undefined;
    }

    const trimmed = inputPath.trim().replace(/^[\\/]+/u, '');
    if (trimmed.length === 0) {
      return undefined;
    }

    const normalizedInput = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    for (const folder of folders) {
      const workspaceName = process.platform === 'win32' ? folder.name.toLowerCase() : folder.name;
      if (normalizedInput === workspaceName) {
        return {
          folder,
          pattern: '**/*',
        };
      }
      if (normalizedInput.startsWith(`${workspaceName}/`) || normalizedInput.startsWith(`${workspaceName}\\`)) {
        const remainder = trimmed.slice(folder.name.length + 1).replace(/^[\\/]+/u, '');
        return {
          folder,
          pattern: remainder.length > 0 ? remainder : '**/*',
        };
      }
    }

    return undefined;
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
  ): Promise<WorkspaceSearchResult> {
    const args: string[] = ['search', target.state.configPath];
    args.push(`L${QGREP_HARD_OUTPUT_LIMIT}`);
    args.push('S');
    if (useCaseInsensitiveSearch) {
      args.push('i');
    }
    if (target.filterRegex) {
      args.push(`fi${target.filterRegex}`);
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
      totalAvailableCapped: summary.capped,
    };
  }

  private shouldUseCaseInsensitiveSearchForQuery(query: string): boolean {
    return !/[A-Z]/u.test(query);
  }

  private async searchFilesInWorkspace(
    target: QgrepSearchTarget,
    query: string,
    mode: QgrepFilesMode,
  ): Promise<WorkspaceFilesResult> {
    const args: string[] = ['files', target.state.configPath];
    if (process.platform === 'win32') {
      args.push('i');
    }
    args.push(`L${QGREP_HARD_OUTPUT_LIMIT}`);
    args.push('S');
    args.push(mode);
    if (target.filterRegex) {
      args.push(`fi${target.filterRegex}`);
    }
    args.push(query);

    const result = await this.runQgrepCommand(args, target.state.folder.uri.fsPath);
    const commandError = this.extractCommandError(result, `File search failed for workspace '${target.state.folder.name}'.`);
    if (commandError) {
      throw new Error(commandError);
    }
    const summary = parseQgrepResultSummary(result.stdout);
    return {
      files: this.parseFilesOutput(result.stdout, target.state.folder, mode),
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
      const parsed = /^(.*):(\d+):(.*)$/u.exec(line);
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
    mode: QgrepFilesMode,
  ): ParsedQgrepFile[] {
    const lines = stdout.split(/\r?\n/u);
    const files: ParsedQgrepFile[] = [];
    const seen = new Set<string>();

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const parsed = this.tryParseFilesOutputLine(line, folder, mode);
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
    mode: QgrepFilesMode,
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

    if (mode !== 'ff') {
      return undefined;
    }

    const tabScoreMatch = QGREP_FILES_SCORE_PREFIX_TAB_PATTERN.exec(line);
    if (tabScoreMatch) {
      const fromTabScore = this.tryResolveFileOutputPath(folder, tabScoreMatch[2].trimStart());
      if (fromTabScore) {
        return { absolutePath: fromTabScore };
      }
    }

    const spaceScoreMatch = QGREP_FILES_SCORE_PREFIX_SPACE_PATTERN.exec(line);
    if (spaceScoreMatch) {
      const fromSpaceScore = this.tryResolveFileOutputPath(folder, spaceScoreMatch[2].trimStart());
      if (fromSpaceScore) {
        return { absolutePath: fromSpaceScore };
      }
    }

    qgrepLogger.warn(`[qgrep.files:${folder.name}] Unparsed ff output line: ${line}`);
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

  private toWorkspaceRelativePath(folder: vscode.WorkspaceFolder, absolutePath: string): string {
    const relativePath = normalizeSlash(path.relative(folder.uri.fsPath, absolutePath));
    return relativePath.length > 0 ? relativePath : '.';
  }

  private matchesGlobSearchPath(
    matcher: QgrepGlobPathMatcher,
    folder: vscode.WorkspaceFolder,
    absolutePath: string,
  ): boolean {
    const candidate = matcher.matchTarget === 'absolute'
      ? normalizeSlash(path.resolve(absolutePath))
      : this.toWorkspaceRelativePath(folder, absolutePath);
    return matcher.regex.test(candidate);
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
    child.on('close', () => {
      this.flushProgressStream(state, stdoutProgress);
      if (stdoutLogLines.pendingText.trim().length > 0) {
        qgrepLogger.info(`[qgrep.watch:${state.folder.name}] ${stdoutLogLines.pendingText.trim()}`);
      }
      if (stderrLines.pendingText.trim().length > 0) {
        this.logWatchLine(state, stderrLines.pendingText.trim());
      }
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
    if (!state.autoUpdateDirty && !state.managedSearchExcludeDirty) {
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
    state.pendingCreateDeleteCount = 0;
    state.autoUpdateDirty = false;
    state.managedSearchExcludeDirty = false;
    state.autoUpdateInFlight = true;
    qgrepLogger.info(
      `[qgrep.autoupdate:${state.folder.name}] queued ${queuedCount} event(s)`
      + (shouldSyncManagedSearchExclude ? ' + search.exclude sync' : ''),
    );

    try {
      const outcome = await this.autoUpdateWorkspace(state, shouldSyncManagedSearchExclude);
      if (outcome === 'done') {
        qgrepLogger.info(`[qgrep.autoupdate:${state.folder.name}] update done`);
      }
    } catch (error) {
      qgrepLogger.warn(`[qgrep.autoupdate:${state.folder.name}] update failed: ${String(error)}`);
    } finally {
      state.autoUpdateInFlight = false;
    }

    if ((state.autoUpdateDirty || state.managedSearchExcludeDirty) && !this.disposed) {
      this.scheduleWorkspaceAutoUpdate(state, 0);
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
      } finally {
        this.setWorkspaceIndexing(state, false);
        if (!this.disposed && this.isWorkspaceInitialized(state)) {
          this.startWatch(state);
        }
      }
    });
    return cancelledByClear ? 'cancelled' : 'done';
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
    const shaderIncludeUpsertResult = upsertManagedConfigBlock(
      normalizedInput,
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

      this.stopWatch(state);
      this.startWatch(state);
      this.ensureAutoUpdateWatcher(state);
    } catch (error) {
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

      this.startWatch(state);
      this.ensureAutoUpdateWatcher(state);
    } catch (error) {
      this.markWorkspaceIndexingFailed(state);
      throw error;
    } finally {
      this.setWorkspaceIndexing(state, false);
    }
  }

  private requireBinaryPath(): string {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`qgrep binary is not available at ${this.binaryPath}.`);
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

interface GlobPatternParserState {
  pattern: string;
  index: number;
}

function isGlobMetaCharacter(char: string): boolean {
  return char === '*' || char === '?' || char === '[' || char === ']' || char === '{' || char === '}';
}

function hasUnescapedGlobMeta(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      const next = pattern[index + 1];
      if (next && isGlobMetaCharacter(next)) {
        index += 1;
      }
      continue;
    }
    if (isGlobMetaCharacter(char)) {
      return true;
    }
  }
  return false;
}

function normalizeWorkspaceSearchGlobPattern(pattern: string): string {
  const trimmed = pattern.trim();
  let normalized = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '/') {
      normalized += '/';
      continue;
    }
    if (char !== '\\') {
      normalized += char;
      continue;
    }

    const next = trimmed[index + 1];
    if (next === undefined) {
      throw new Error('Invalid searchPath glob pattern: trailing escape (\\).');
    }
    if (next === '/' || next === '\\') {
      normalized += '/';
      index += 1;
      continue;
    }
    if (isGlobMetaCharacter(next) || next === ',') {
      const previousNormalizedChar = normalized.length > 0 ? normalized[normalized.length - 1] : '';
      const treatAsEscape = previousNormalizedChar === '' || previousNormalizedChar === '/';
      if (treatAsEscape) {
        normalized += `\\${next}`;
        index += 1;
        continue;
      }
    }

    normalized += '/';
  }

  const hasUncPrefix = normalized.startsWith('//');
  const uncSafeNormalized = hasUncPrefix
    ? `//${normalized.slice(2).replace(/\/{2,}/g, '/')}`
    : normalized.replace(/\/{2,}/g, '/');

  return uncSafeNormalized.replace(/^\.\//u, '');
}

function compileWorkspaceGlobPathMatcher(pattern: string): QgrepGlobPathMatcher {
  const normalizedPattern = normalizeWorkspaceSearchGlobPattern(pattern);
  if (normalizedPattern.length === 0) {
    throw new Error('searchPath glob must be a non-empty string.');
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
      regex,
      matchTarget: 'relative',
    };
  } catch (error) {
    throw new Error(`Invalid searchPath glob pattern: ${String(error)}`);
  }
}

function compileAbsoluteGlobPathMatcher(pattern: string): QgrepGlobPathMatcher {
  const normalizedPattern = normalizeWorkspaceSearchGlobPattern(pattern);
  if (!isAbsolutePath(normalizedPattern)) {
    throw new Error(`searchPath glob must be an absolute path pattern: ${pattern}`);
  }

  const regexSource = compileWorkspaceGlobToRegexSource(normalizedPattern);
  const fullSource = `^${regexSource}$`;
  const flags = process.platform === 'win32' ? 'iu' : 'u';

  try {
    const regex = new RegExp(fullSource, flags);
    return {
      pattern: normalizedPattern,
      regex,
      matchTarget: 'absolute',
    };
  } catch (error) {
    throw new Error(`Invalid searchPath glob pattern: ${String(error)}`);
  }
}

function compileWorkspaceGlobToRegexSource(glob: string): string {
  const state: GlobPatternParserState = {
    pattern: glob,
    index: 0,
  };
  const source = parseGlobSequence(state, '');
  if (state.index !== state.pattern.length) {
    throw new Error(`Invalid searchPath glob pattern near index ${String(state.index)}.`);
  }
  return source;
}

function parseGlobSequence(state: GlobPatternParserState, stopChars: string): string {
  let result = '';
  while (state.index < state.pattern.length) {
    const char = state.pattern[state.index];
    if (stopChars.includes(char)) {
      break;
    }

    if (char === '\\') {
      state.index += 1;
      if (state.index >= state.pattern.length) {
        throw new Error('Invalid searchPath glob pattern: trailing escape (\\).');
      }
      const escaped = state.pattern[state.index];
      result += escapeRegex(escaped);
      state.index += 1;
      continue;
    }

    if (char === '*') {
      if (state.pattern[state.index + 1] === '*') {
        let endIndex = state.index + 1;
        while (state.pattern[endIndex + 1] === '*') {
          endIndex += 1;
        }
        state.index = endIndex + 1;
        if (state.pattern[state.index] === '/') {
          state.index += 1;
          result += '(?:.*/)?';
        } else {
          result += '.*';
        }
        continue;
      }
      state.index += 1;
      result += '[^/]*';
      continue;
    }

    if (char === '?') {
      state.index += 1;
      result += '[^/]';
      continue;
    }

    if (char === '[') {
      result += parseGlobCharClass(state);
      continue;
    }

    if (char === '{') {
      result += parseGlobBraceGroup(state);
      continue;
    }

    if (char === '/') {
      result += '/';
      state.index += 1;
      while (state.pattern[state.index] === '/') {
        state.index += 1;
      }
      continue;
    }

    result += escapeRegex(char);
    state.index += 1;
  }
  return result;
}

function parseGlobCharClass(state: GlobPatternParserState): string {
  state.index += 1;
  if (state.index >= state.pattern.length) {
    throw new Error('Invalid searchPath glob pattern: unterminated character class.');
  }

  let negated = false;
  const first = state.pattern[state.index];
  if (first === '!' || first === '^') {
    negated = true;
    state.index += 1;
  }

  let content = '';
  let hasContent = false;
  while (state.index < state.pattern.length) {
    const char = state.pattern[state.index];
    if (char === ']' && hasContent) {
      state.index += 1;
      return `[${negated ? '^' : ''}${content}]`;
    }

    if (char === '\\') {
      state.index += 1;
      if (state.index >= state.pattern.length) {
        throw new Error('Invalid searchPath glob pattern: unterminated escape in character class.');
      }
      content += escapeRegexCharClass(state.pattern[state.index]);
      hasContent = true;
      state.index += 1;
      continue;
    }

    if (char === '/') {
      content += '\\/';
      hasContent = true;
      state.index += 1;
      continue;
    }

    content += escapeRegexCharClass(char);
    hasContent = true;
    state.index += 1;
  }

  throw new Error('Invalid searchPath glob pattern: unterminated character class.');
}

function parseGlobBraceGroup(state: GlobPatternParserState): string {
  state.index += 1;
  const branches: string[] = [];
  while (true) {
    const branch = parseGlobSequence(state, ',}');
    branches.push(branch);
    if (state.index >= state.pattern.length) {
      throw new Error('Invalid searchPath glob pattern: unterminated brace expression.');
    }
    const token = state.pattern[state.index];
    if (token === ',') {
      state.index += 1;
      continue;
    }
    if (token === '}') {
      state.index += 1;
      break;
    }
  }
  return `(?:${branches.join('|')})`;
}

function escapeRegexCharClass(char: string): string {
  if (char === '\\' || char === ']' || char === '^') {
    return `\\${char}`;
  }
  return char;
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
