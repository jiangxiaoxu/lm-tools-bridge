import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const QGREP_DIR_NAME = 'qgrep';
const QGREP_CONFIG_FILE_NAME = 'workspace.cfg';
const WATCH_RESTART_DELAY_MS = 1000;
const DEFAULT_MAX_RESULTS = 200;
const MIN_MAX_RESULTS = 1;
const INIT_COMMAND_HINT = 'Run "LM Tools Bridge: Qgrep Init All Workspaces" first.';
const QGREP_PROGRESS_FRAME_PATTERN = /\[\s*(\d{1,3})%\]\s+(\d+)\s+files\b/u;

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
  restartOnExit: boolean;
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

interface QgrepSearchTarget {
  state: WorkspaceQgrepState;
  filterRegex?: string;
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

class QgrepService implements vscode.Disposable {
  private readonly states = new Map<string, WorkspaceQgrepState>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  constructor(private readonly binaryPath: string) {}

  public activate(): void {
    this.syncWorkspaceStates(vscode.workspace.workspaceFolders ?? []);
    this.startWatchForInitializedWorkspaces();
    this.notifyStatusChanged();

    const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      this.handleWorkspaceFolderChanges(event);
    });
    this.subscriptions.push(folderWatcher);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const state of this.states.values()) {
      this.stopWatch(state);
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

  public async rebuildAllInitializedWorkspaces(): Promise<QgrepCommandSummary> {
    const initializedStates = this.getInitializedStates();
    if (initializedStates.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const failures: string[] = [];
    let processed = 0;
    for (const state of initializedStates) {
      try {
        await this.rebuildWorkspace(state);
        processed += 1;
      } catch (error) {
        failures.push(`${state.folder.name}: ${String(error)}`);
      }
    }

    const summary = this.buildSummary(
      initializedStates.length,
      processed,
      failures,
      failures.length === 0
        ? `Qgrep indexes rebuilt for ${processed}/${initializedStates.length} workspace(s).`
        : `Qgrep indexes rebuilt for ${processed}/${initializedStates.length} workspace(s), ${failures.length} failed.`,
    );
    return summary;
  }

  public async stopAndClearAllInitializedWorkspaces(): Promise<QgrepCommandSummary> {
    const initializedStates = this.getInitializedStates();
    if (initializedStates.length === 0) {
      return this.buildSummary(0, 0, [], 'No initialized qgrep workspace found.');
    }

    const failures: string[] = [];
    let processed = 0;
    for (const state of initializedStates) {
      try {
        this.stopWatch(state);
        await fs.promises.rm(state.qgrepDirPath, { recursive: true, force: true });
        this.resetWorkspaceProgress(state);
        processed += 1;
      } catch (error) {
        failures.push(`${state.folder.name}: ${String(error)}`);
      }
    }

    const summary = this.buildSummary(
      initializedStates.length,
      processed,
      failures,
      failures.length === 0
        ? `Qgrep index directory cleared for ${processed}/${initializedStates.length} workspace(s).`
        : `Qgrep index directory cleared for ${processed}/${initializedStates.length} workspace(s), ${failures.length} failed.`,
    );
    return summary;
  }

  public async search(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = this.parseQuery(input);
    const searchPath = this.parseOptionalSearchPath(input);
    const maxResults = this.parseMaxResults(input);
    const targets = this.resolveSearchTargets(searchPath);
    if (targets.length === 0) {
      throw new Error(`No initialized qgrep workspace found. ${INIT_COMMAND_HINT}`);
    }

    const matches: Array<Record<string, unknown>> = [];
    let remaining = maxResults;
    let capped = false;

    for (const target of targets) {
      if (remaining <= 0) {
        capped = true;
        break;
      }

      const targetMatches = await this.searchInWorkspace(target, query, remaining);
      if (targetMatches.length >= remaining) {
        capped = true;
      }

      for (const match of targetMatches) {
        if (remaining <= 0) {
          capped = true;
          break;
        }
        matches.push(this.toMatchPayload(target.state.folder, match));
        remaining -= 1;
      }
    }

    return {
      query,
      searchPath: searchPath ?? null,
      maxResults,
      count: matches.length,
      capped,
      matches,
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
      return `^${escaped}(?:/|$)`;
    }
    return `^${escaped}$`;
  }

  private async searchInWorkspace(
    target: QgrepSearchTarget,
    query: string,
    maxResults: number,
  ): Promise<ParsedQgrepMatch[]> {
    const args: string[] = ['search', target.state.configPath, `L${maxResults}`];
    if (target.filterRegex) {
      args.push(`fi${target.filterRegex}`);
    }
    args.push(query);

    const result = await this.runQgrepCommand(args, target.state.folder.uri.fsPath);
    const commandError = this.extractCommandError(result, `Search failed for workspace '${target.state.folder.name}'.`);
    if (commandError) {
      throw new Error(commandError);
    }
    return this.parseSearchOutput(result.stdout, target.state.folder);
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

  private startWatchForInitializedWorkspaces(): void {
    for (const state of this.states.values()) {
      if (!this.isWorkspaceInitialized(state)) {
        continue;
      }
      this.startWatch(state);
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
          qgrepLogger.warn(`[qgrep.watch:${state.folder.name}] ${line}`);
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
        qgrepLogger.warn(`[qgrep.watch:${state.folder.name}] ${stderrLines.pendingText.trim()}`);
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

  private async initWorkspace(state: WorkspaceQgrepState): Promise<void> {
    this.requireBinaryPath();
    await fs.promises.mkdir(state.qgrepDirPath, { recursive: true });
    this.setWorkspaceIndexing(state, true);

    try {
      if (!this.isWorkspaceInitialized(state)) {
        const initResult = await this.runQgrepCommand(
          ['init', state.configPath, state.folder.uri.fsPath],
          state.folder.uri.fsPath,
          { progressState: state },
        );
        const initError = this.extractCommandError(initResult, `Init failed for workspace '${state.folder.name}'.`);
        if (initError) {
          throw new Error(initError);
        }
      }

      const updateResult = await this.runQgrepCommand(
        ['update', state.configPath],
        state.folder.uri.fsPath,
        { progressState: state },
      );
      const updateError = this.extractCommandError(updateResult, `Update failed for workspace '${state.folder.name}'.`);
      if (updateError) {
        throw new Error(updateError);
      }

      this.stopWatch(state);
      this.startWatch(state);
    } catch (error) {
      this.markWorkspaceIndexingFailed(state);
      throw error;
    } finally {
      this.setWorkspaceIndexing(state, false);
    }
  }

  private async rebuildWorkspace(state: WorkspaceQgrepState): Promise<void> {
    this.requireBinaryPath();
    this.stopWatch(state);
    this.setWorkspaceIndexing(state, true);

    try {
      const buildResult = await this.runQgrepCommand(
        ['build', state.configPath],
        state.folder.uri.fsPath,
        { progressState: state },
      );
      const buildError = this.extractCommandError(buildResult, `Build failed for workspace '${state.folder.name}'.`);
      if (buildError) {
        throw new Error(buildError);
      }

      this.startWatch(state);
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
  return requireQgrepService().rebuildAllInitializedWorkspaces();
}

export async function runQgrepStopAndClearCommand(): Promise<QgrepCommandSummary> {
  return requireQgrepService().stopAndClearAllInitializedWorkspaces();
}

export async function executeQgrepSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requireQgrepService().search(input);
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
