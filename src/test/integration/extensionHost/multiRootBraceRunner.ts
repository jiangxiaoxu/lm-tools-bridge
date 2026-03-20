import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import {
  executeQgrepFilesSearch,
  executeQgrepSearch,
  getQgrepStatusSummary,
  runQgrepInitAllWorkspacesCommand,
  runQgrepStopAndClearCommand,
} from '../../../qgrep';
import {
  QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK,
  QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED,
} from '../../../qgrepTextQuery';
import {
  activateExtension,
  runIntegrationTests,
  waitForWorkspaceFolderNames,
} from './testHarness';
import { executeFindTextInFilesSearch } from '../../../searchTools';

const QGREP_READY_TIMEOUT_MS = 30_000;
const QGREP_READY_POLL_INTERVAL_MS = 100;
const BRACE_SCOPED_QUERY = '{WorkspaceA,WorkspaceB}/Source/**/*.{h,cpp,cs,as}';
const BRACE_SCOPED_NORMALIZED_QUERY = '{WorkspaceB,WorkspaceA,WorkspaceB}/Source/**/*.{h,cpp,cs,as}';
const BRACE_UNREAL_CONFIG_QUERY = '{WorkspaceA,WorkspaceB}/**/*.{uplugin,uproject}';
const BRACE_SCOPED_TEXT_QUERY = '#include';
const BRACE_UNREAL_CONFIG_TEXT_QUERY = 'BraceWorkspaceConfigSignal';
const BRACE_SCOPED_PIPE_TEXT_QUERY = 'BraceWorkspaceSignal|GameSettingRegistry';
const BRACE_SCOPED_QUOTED_PIPE_TEXT_QUERY = '"BraceWorkspaceSignal|GameSettingRegistry"';
const BRACE_SCOPED_ESCAPED_PIPE_TEXT_QUERY = 'BraceWorkspaceSignal\\|GameSettingRegistry';
const BRACE_SCOPED_SPACE_PIPE_TEXT_QUERY = 'SpacePipeLeft | SpacePipeRight';
const BRACE_SCOPED_BROKEN_QUOTE_PIPE_TEXT_QUERY = '"BrokenPipeLeft|BrokenPipeRight';
const BRACE_SCOPED_FALLBACK_PIPE_TEXT_QUERY = 'BrokenPipe||Literal';
const BRACE_SCOPED_SINGLE_SPACE_PIPE_TEXT_QUERY = 'BrokenPipe| |Literal';
const BRACE_SCOPED_REGEX_INCLUDE_QUERY = '#include\\s+"[^"]+"';
const BRACE_SCOPED_REGEX_GAME_SETTING_QUERY = 'GameSetting(Value|Registry)';
const BRACE_SCOPED_CONTEXT_CLAMP_BEFORE = 80;
const BRACE_SCOPED_CONTEXT_CLAMP_AFTER = 8;
const BRACE_SCOPED_BRIDGE_ANCHOR_FILE = 'WorkspaceB/Source/Tools/BridgeAnchor.cs';
const MIXED_SCOPED_UNSCOPED_QUERY = '{WorkspaceA/Source/Tools/**/*.cs,WorkspaceB/Source/Editor/**/*.{h,cpp},Source/Scripting/**/*.as}';
const MIXED_SCOPED_UNSCOPED_OVERLAP_QUERY = '{WorkspaceA/Source/Scripting/**/*.as,Source/Scripting/**/*.as}';
const MIXED_SCOPED_UNSCOPED_TEXT_QUERY = 'BraceWorkspaceSignal';
const BRACE_WORKSPACE_NAMES = ['WorkspaceA', 'WorkspaceB'];
const BRACE_SCOPED_EXTENSIONS = new Set<string>(['.h', '.cpp', '.cs', '.as']);
const BRACE_UNREAL_CONFIG_WORKSPACE_PATHS = [
  'WorkspaceA/BraceWorkspaceA.uproject',
  'WorkspaceB/Plugins/BraceWorkspacePlugin/BraceWorkspacePlugin.uplugin',
];
const MIN_EXPECTED_BRACE_SCOPED_FILES = 100;
const MIN_EXPECTED_PER_WORKSPACE_FILES = 20;
const MIXED_SCOPED_UNSCOPED_EXPECTED_PATHS = new Set<string>([
  'WorkspaceA/Source/Scripting/ScopeAnchor.as',
  'WorkspaceA/Source/Tools/ScopeAnchor.cs',
  'WorkspaceB/Source/Scripting/BridgeAnchor.as',
  'WorkspaceB/Source/Editor/Public/BridgeAnchor.h',
  'WorkspaceB/Source/Editor/Private/BridgeAnchor.cpp',
]);
const MIXED_SCOPED_UNSCOPED_OVERLAP_EXPECTED_PATHS = new Set<string>([
  'WorkspaceA/Source/Scripting/ScopeAnchor.as',
  'WorkspaceB/Source/Scripting/BridgeAnchor.as',
]);

interface QgrepFileRecord {
  absolutePath: string;
  workspacePath: string;
  workspaceFolder: string;
}

interface QgrepMatchRecord extends QgrepFileRecord {
  line: number;
  preview: string;
}

interface ExpectedFixtureFile extends QgrepFileRecord {}

interface ExpectedFixtureMatch extends QgrepMatchRecord {}

interface FindTextMatchRecord {
  path: string;
  line: number;
  preview: string;
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/');
}

function getBraceWorkspaceFolders(): vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.filter((folder) => BRACE_WORKSPACE_NAMES.includes(folder.name));
}

async function collectFilesRecursively(directoryPath: string): Promise<string[]> {
  const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFilesRecursively(entryPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function collectBraceScopedFixtureFiles(): Promise<ExpectedFixtureFile[]> {
  const files: ExpectedFixtureFile[] = [];
  for (const folder of getBraceWorkspaceFolders()) {
    const sourceRoot = path.join(folder.uri.fsPath, 'Source');
    const sourceFiles = await collectFilesRecursively(sourceRoot);
    for (const absolutePath of sourceFiles) {
      if (!BRACE_SCOPED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
        continue;
      }
      const normalizedAbsolutePath = normalizePath(path.resolve(absolutePath));
      const relativePath = normalizePath(path.relative(folder.uri.fsPath, absolutePath));
      files.push({
        absolutePath: normalizedAbsolutePath,
        workspacePath: `${folder.name}/${relativePath}`,
        workspaceFolder: folder.name,
      });
    }
  }
  files.sort(compareFileRecords);
  return files;
}

async function collectBraceFixtureFilesByWorkspacePathSet(
  workspacePaths: ReadonlySet<string>,
): Promise<ExpectedFixtureFile[]> {
  const files = await collectBraceScopedFixtureFiles();
  const selected = files.filter((file) => workspacePaths.has(file.workspacePath));
  selected.sort(compareFileRecords);
  return selected;
}

async function collectExplicitWorkspacePathFiles(
  workspacePaths: readonly string[],
): Promise<ExpectedFixtureFile[]> {
  const workspaceFolderMap = new Map(getBraceWorkspaceFolders().map((folder) => [folder.name, folder]));
  const files: ExpectedFixtureFile[] = [];
  for (const workspacePath of workspacePaths) {
    const [workspaceName, ...relativeSegments] = workspacePath.split('/');
    assert.ok(workspaceName, `Expected workspace-qualified path, received '${workspacePath}'.`);
    const folder = workspaceFolderMap.get(workspaceName);
    assert.ok(folder, `Expected workspace '${workspaceName}' to exist for '${workspacePath}'.`);
    const relativePath = relativeSegments.join('/');
    const absolutePath = path.resolve(folder.uri.fsPath, relativePath);
    await fs.promises.access(absolutePath, fs.constants.F_OK);
    files.push({
      absolutePath: normalizePath(absolutePath),
      workspacePath,
      workspaceFolder: workspaceName,
    });
  }
  files.sort(compareFileRecords);
  return files;
}

async function collectFixtureMatchesInFiles(
  files: readonly ExpectedFixtureFile[],
  queries: string | readonly string[],
): Promise<ExpectedFixtureMatch[]> {
  const queryList = typeof queries === 'string' ? [queries] : [...queries];
  const useCaseInsensitive = queryList.every((query) => !/[A-Z]/u.test(query));
  const normalizedQueries = useCaseInsensitive
    ? queryList.map((query) => query.toLowerCase())
    : queryList;
  const matches: ExpectedFixtureMatch[] = [];
  for (const file of files) {
    const fileText = await fs.promises.readFile(file.absolutePath, 'utf8');
    const lines = fileText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? '';
      const candidate = useCaseInsensitive ? lineText.toLowerCase() : lineText;
      if (!normalizedQueries.some((query) => candidate.includes(query))) {
        continue;
      }
      matches.push({
        ...file,
        line: index + 1,
        preview: lineText,
      });
    }
  }
  matches.sort(compareMatchRecords);
  return matches;
}

async function collectBraceScopedFixtureMatches(query: string): Promise<ExpectedFixtureMatch[]> {
  return collectFixtureMatchesInFiles(await collectBraceScopedFixtureFiles(), query);
}

async function collectBraceScopedFixtureMatchesForQueries(
  queries: readonly string[],
): Promise<ExpectedFixtureMatch[]> {
  return collectFixtureMatchesInFiles(await collectBraceScopedFixtureFiles(), queries);
}

async function collectBraceScopedFixtureRegexMatches(
  query: string,
  caseSensitive?: boolean,
): Promise<ExpectedFixtureMatch[]> {
  const matches: ExpectedFixtureMatch[] = [];
  const flags = shouldUseCaseInsensitiveRegexQuery(query, caseSensitive) ? 'iu' : 'u';
  const matcher = new RegExp(query, flags);

  for (const file of await collectBraceScopedFixtureFiles()) {
    const fileText = await fs.promises.readFile(file.absolutePath, 'utf8');
    const lines = fileText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? '';
      if (!matcher.test(lineText)) {
        continue;
      }
      matches.push({
        ...file,
        line: index + 1,
        preview: lineText,
      });
    }
  }

  matches.sort(compareMatchRecords);
  return matches;
}

async function collectMixedScopedUnscopedFixtureFiles(): Promise<ExpectedFixtureFile[]> {
  return collectBraceFixtureFilesByWorkspacePathSet(MIXED_SCOPED_UNSCOPED_EXPECTED_PATHS);
}

async function collectMixedScopedUnscopedFixtureMatches(): Promise<ExpectedFixtureMatch[]> {
  return collectFixtureMatchesInFiles(
    await collectMixedScopedUnscopedFixtureFiles(),
    MIXED_SCOPED_UNSCOPED_TEXT_QUERY,
  );
}

async function collectMixedScopedUnscopedOverlapFixtureFiles(): Promise<ExpectedFixtureFile[]> {
  return collectBraceFixtureFilesByWorkspacePathSet(MIXED_SCOPED_UNSCOPED_OVERLAP_EXPECTED_PATHS);
}

async function collectMixedScopedUnscopedOverlapFixtureMatches(): Promise<ExpectedFixtureMatch[]> {
  return collectFixtureMatchesInFiles(
    await collectMixedScopedUnscopedOverlapFixtureFiles(),
    MIXED_SCOPED_UNSCOPED_TEXT_QUERY,
  );
}

function assertFixtureRichEnough(expectedFiles: readonly ExpectedFixtureFile[]): void {
  assert.ok(
    expectedFiles.length >= MIN_EXPECTED_BRACE_SCOPED_FILES,
    `Expected at least ${String(MIN_EXPECTED_BRACE_SCOPED_FILES)} brace-scoped fixture files, received ${String(expectedFiles.length)}.`,
  );
  const countsByWorkspace = new Map<string, number>();
  for (const file of expectedFiles) {
    countsByWorkspace.set(file.workspaceFolder, (countsByWorkspace.get(file.workspaceFolder) ?? 0) + 1);
  }
  for (const workspaceName of BRACE_WORKSPACE_NAMES) {
    const workspaceCount = countsByWorkspace.get(workspaceName) ?? 0;
    assert.ok(
      workspaceCount >= MIN_EXPECTED_PER_WORKSPACE_FILES,
      `Expected workspace '${workspaceName}' to contribute at least ${String(MIN_EXPECTED_PER_WORKSPACE_FILES)} files, received ${String(workspaceCount)}.`,
    );
  }
}

function collectFileRecords(payload: Record<string, unknown>): QgrepFileRecord[] {
  assert.ok(Array.isArray(payload.files), 'Expected payload.files to be an array.');
  return payload.files.map((entry, index) => {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `Expected files[${String(index)}] to be an object.`);
    const record = entry as {
      absolutePath?: unknown;
      workspacePath?: unknown;
      workspaceFolder?: unknown;
    };
    assert.equal(typeof record.absolutePath, 'string', `Expected files[${String(index)}].absolutePath to be a string.`);
    assert.equal(typeof record.workspacePath, 'string', `Expected files[${String(index)}].workspacePath to be a string.`);
    assert.equal(typeof record.workspaceFolder, 'string', `Expected files[${String(index)}].workspaceFolder to be a string.`);
    return {
      absolutePath: normalizePath(record.absolutePath as string),
      workspacePath: record.workspacePath as string,
      workspaceFolder: record.workspaceFolder as string,
    };
  });
}

function collectMatchRecords(payload: Record<string, unknown>): QgrepMatchRecord[] {
  assert.ok(Array.isArray(payload.matches), 'Expected payload.matches to be an array.');
  return payload.matches.map((entry, index) => {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `Expected matches[${String(index)}] to be an object.`);
    const record = entry as {
      absolutePath?: unknown;
      workspacePath?: unknown;
      workspaceFolder?: unknown;
      line?: unknown;
      preview?: unknown;
    };
    assert.equal(typeof record.absolutePath, 'string', `Expected matches[${String(index)}].absolutePath to be a string.`);
    assert.equal(typeof record.workspacePath, 'string', `Expected matches[${String(index)}].workspacePath to be a string.`);
    assert.equal(typeof record.workspaceFolder, 'string', `Expected matches[${String(index)}].workspaceFolder to be a string.`);
    assert.equal(typeof record.line, 'number', `Expected matches[${String(index)}].line to be a number.`);
    assert.equal(typeof record.preview, 'string', `Expected matches[${String(index)}].preview to be a string.`);
    return {
      absolutePath: normalizePath(record.absolutePath as string),
      workspacePath: record.workspacePath as string,
      workspaceFolder: record.workspaceFolder as string,
      line: record.line as number,
      preview: record.preview as string,
    };
  });
}

function compareFileRecords(left: QgrepFileRecord, right: QgrepFileRecord): number {
  return left.workspacePath.localeCompare(right.workspacePath);
}

function compareMatchRecords(left: QgrepMatchRecord, right: QgrepMatchRecord): number {
  const workspacePathResult = left.workspacePath.localeCompare(right.workspacePath);
  if (workspacePathResult !== 0) {
    return workspacePathResult;
  }
  return left.line - right.line;
}

function shouldUseCaseInsensitiveRegexQuery(query: string, caseSensitive?: boolean): boolean {
  if (caseSensitive === true) {
    return false;
  }
  return !/[A-Z]/u.test(query);
}

function assertFileRecordsMatch(payload: Record<string, unknown>, expectedFiles: readonly ExpectedFixtureFile[]): void {
  const records = collectFileRecords(payload);
  const sortedActual = [...records].sort(compareFileRecords);
  assert.deepEqual(
    sortedActual.map(({ workspacePath, absolutePath, workspaceFolder }) => ({ workspacePath, absolutePath, workspaceFolder })),
    expectedFiles.map(({ workspacePath, absolutePath, workspaceFolder }) => ({ workspacePath, absolutePath, workspaceFolder })),
  );
}

function assertMatchRecordsMatch(payload: Record<string, unknown>, expectedMatches: readonly ExpectedFixtureMatch[]): void {
  const records = [...collectMatchRecords(payload)].sort(compareMatchRecords);
  assert.deepEqual(
    records.map(({ workspacePath, absolutePath, workspaceFolder, line, preview }) => ({
      workspacePath,
      absolutePath,
      workspaceFolder,
      line,
      preview,
    })),
    expectedMatches.map(({ workspacePath, absolutePath, workspaceFolder, line, preview }) => ({
      workspacePath,
      absolutePath,
      workspaceFolder,
      line,
      preview,
    })),
  );
}

function collectFindTextMatchRecords(payload: Record<string, unknown>): FindTextMatchRecord[] {
  assert.ok(Array.isArray(payload.matches), 'Expected payload.matches to be an array.');
  return payload.matches.map((entry, index) => {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `Expected matches[${String(index)}] to be an object.`);
    const record = entry as {
      path?: unknown;
      line?: unknown;
      preview?: unknown;
    };
    assert.equal(typeof record.path, 'string', `Expected matches[${String(index)}].path to be a string.`);
    assert.equal(typeof record.line, 'number', `Expected matches[${String(index)}].line to be a number.`);
    assert.equal(typeof record.preview, 'string', `Expected matches[${String(index)}].preview to be a string.`);
    return {
      path: normalizePath(record.path as string),
      line: record.line as number,
      preview: record.preview as string,
    };
  });
}

function assertFindTextMatchRecordsMatch(
  payload: Record<string, unknown>,
  expectedMatches: readonly ExpectedFixtureMatch[],
): void {
  const actual = collectFindTextMatchRecords(payload).sort((left, right) => {
    const pathResult = left.path.localeCompare(right.path);
    if (pathResult !== 0) {
      return pathResult;
    }
    return left.line - right.line;
  });
  const expected = expectedMatches
    .map((match) => ({
      path: match.absolutePath,
      line: match.line,
      preview: match.preview,
    }))
    .sort((left, right) => {
      const pathResult = left.path.localeCompare(right.path);
      if (pathResult !== 0) {
        return pathResult;
      }
      return left.line - right.line;
    });
  assert.deepEqual(actual, expected);
}

async function ensureQgrepReady(): Promise<void> {
  const clearSummary = await runQgrepStopAndClearCommand();
  assert.equal(clearSummary.failed, 0, `Expected qgrep clear to succeed: ${clearSummary.message}`);

  const initSummary = await runQgrepInitAllWorkspacesCommand();
  assert.equal(initSummary.failed, 0, `Expected qgrep init to succeed: ${initSummary.message}`);
  assert.equal(initSummary.processed, 2);

  let status = getQgrepStatusSummary();
  const deadline = Date.now() + QGREP_READY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    status = getQgrepStatusSummary();
    if (
      status.initializedWorkspaces === 2
      && status.workspaceStatuses.length === 2
      && status.workspaceStatuses.every((workspaceStatus) => workspaceStatus.initialized && workspaceStatus.indexing === false)
    ) {
      return;
    }
    await delay(QGREP_READY_POLL_INTERVAL_MS);
  }

  assert.equal(status.initializedWorkspaces, 2, 'Expected qgrep to initialize both workspace indexes.');
  assert.equal(
    status.workspaceStatuses.every((workspaceStatus) => workspaceStatus.initialized && workspaceStatus.indexing === false),
    true,
    `Expected qgrep indexes to become ready. Last status: ${JSON.stringify(status.workspaceStatuses)}`,
  );
}

export async function run(): Promise<void> {
  await runIntegrationTests('multi-root-brace', [
    {
      name: 'opens the anonymized brace fixture as a multi-root workspace',
      run: async () => {
        await activateExtension();
        await waitForWorkspaceFolderNames(['WorkspaceA', 'WorkspaceB']);
      },
    },
    {
      name: 'aggregates brace-scoped qgrep file glob queries across the selected workspaces',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedFiles = await collectBraceScopedFixtureFiles();
        assertFixtureRichEnough(expectedFiles);

        const payload = await executeQgrepFilesSearch({
          query: BRACE_SCOPED_QUERY,
          maxResults: 400,
        });

        assert.equal(payload.scope, '{WorkspaceA,WorkspaceB}');
        assert.equal(payload.querySemanticsApplied, 'glob-vscode');
        assert.equal(payload.count, expectedFiles.length);
        assert.equal(payload.totalAvailable, expectedFiles.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 400);
        assertFileRecordsMatch(payload, expectedFiles);
      },
    },
    {
      name: 'normalizes brace-scoped workspace selectors with repeated workspace names',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedFiles = await collectBraceScopedFixtureFiles();

        const payload = await executeQgrepFilesSearch({
          query: BRACE_SCOPED_NORMALIZED_QUERY,
          maxResults: 400,
        });

        assert.equal(payload.scope, '{WorkspaceB,WorkspaceA}');
        assert.equal(payload.count, expectedFiles.length);
        assert.equal(payload.totalAvailable, expectedFiles.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 400);
        assertFileRecordsMatch(payload, expectedFiles);
      },
    },
    {
      name: 'indexes Unreal project and plugin config files through the managed include set',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedFiles = await collectExplicitWorkspacePathFiles(BRACE_UNREAL_CONFIG_WORKSPACE_PATHS);

        const payload = await executeQgrepFilesSearch({
          query: BRACE_UNREAL_CONFIG_QUERY,
          maxResults: 50,
        });

        assert.equal(payload.scope, '{WorkspaceA,WorkspaceB}');
        assert.equal(payload.querySemanticsApplied, 'glob-vscode');
        assert.equal(payload.count, expectedFiles.length);
        assert.equal(payload.totalAvailable, expectedFiles.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 50);
        assertFileRecordsMatch(payload, expectedFiles);
      },
    },
    {
      name: 'applies mixed scoped and unscoped top-level brace alternation to qgrep file search',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedFiles = await collectMixedScopedUnscopedFixtureFiles();

        const payload = await executeQgrepFilesSearch({
          query: MIXED_SCOPED_UNSCOPED_QUERY,
          maxResults: 400,
        });

        assert.equal(payload.scope ?? null, null);
        assert.equal(payload.querySemanticsApplied, 'glob-vscode');
        assert.equal(payload.count, expectedFiles.length);
        assert.equal(payload.totalAvailable, expectedFiles.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 400);
        assertFileRecordsMatch(payload, expectedFiles);
      },
    },
    {
      name: 'applies brace-scoped includePattern filtering to qgrep text search',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureMatches(BRACE_SCOPED_TEXT_QUERY);
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain text matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_TEXT_QUERY,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 1500,
        });

        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'insensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 1500);
        assert.equal(payload.queryHints, undefined);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'searches inside Unreal project and plugin config files through the managed include set',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectFixtureMatchesInFiles(
          await collectExplicitWorkspacePathFiles(BRACE_UNREAL_CONFIG_WORKSPACE_PATHS),
          BRACE_UNREAL_CONFIG_TEXT_QUERY,
        );
        assert.ok(expectedMatches.length > 0, 'Expected Unreal config fixture files to contain text matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_UNREAL_CONFIG_TEXT_QUERY,
          includePattern: BRACE_UNREAL_CONFIG_QUERY,
          maxResults: 50,
        });

        assert.equal(payload.includePattern, BRACE_UNREAL_CONFIG_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 50);
        assert.equal(payload.queryHints, undefined);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'applies brace-scoped includePattern filtering to lm_findTextInFiles',
      run: async () => {
        await activateExtension();
        const expectedMatches = await collectBraceScopedFixtureMatches(BRACE_SCOPED_TEXT_QUERY);
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain ripgrep text matches.');

        const payload = await executeFindTextInFilesSearch({
          query: BRACE_SCOPED_TEXT_QUERY,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 1500,
        });

        assert.equal(payload.capped, false);
        assert.equal(payload.uniqueMatches, expectedMatches.length);
        assert.equal(payload.totalMatches, expectedMatches.length);
        assertFindTextMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'applies mixed scoped and unscoped brace alternation to lm_findTextInFiles',
      run: async () => {
        await activateExtension();
        const expectedMatches = await collectMixedScopedUnscopedFixtureMatches();
        assert.ok(expectedMatches.length > 0, 'Expected mixed scoped/unscoped fixture to contain ripgrep text matches.');

        const payload = await executeFindTextInFilesSearch({
          query: MIXED_SCOPED_UNSCOPED_TEXT_QUERY,
          includePattern: MIXED_SCOPED_UNSCOPED_QUERY,
          maxResults: 200,
        });

        assert.equal(payload.capped, false);
        assert.equal(payload.uniqueMatches, expectedMatches.length);
        assert.equal(payload.totalMatches, expectedMatches.length);
        assertFindTextMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'accepts absolute file includePattern in lm_findTextInFiles',
      run: async () => {
        await activateExtension();
        const [expectedFile] = await collectExplicitWorkspacePathFiles([BRACE_SCOPED_BRIDGE_ANCHOR_FILE]);
        assert.ok(expectedFile, 'Expected bridge anchor fixture file.');
        const expectedMatches = await collectFixtureMatchesInFiles([expectedFile], 'SpacePipeLeft');
        assert.ok(expectedMatches.length > 0, 'Expected absolute includePattern file to contain ripgrep text matches.');

        const payload = await executeFindTextInFilesSearch({
          query: 'SpacePipeLeft',
          includePattern: expectedFile.absolutePath,
          maxResults: 50,
        });

        assert.equal(payload.capped, false);
        assert.equal(payload.uniqueMatches, expectedMatches.length);
        assert.equal(payload.totalMatches, expectedMatches.length);
        assertFindTextMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'rejects lm_findTextInFiles includePattern outside current workspaces',
      run: async () => {
        await activateExtension();
        const outsidePattern = process.platform === 'win32'
          ? 'D:/outside/**/*.ts'
          : '/outside/**/*.ts';

        await assert.rejects(
          () => executeFindTextInFilesSearch({
            query: BRACE_SCOPED_TEXT_QUERY,
            includePattern: outsidePattern,
          }),
          /includePattern is outside current workspaces/u,
        );
      },
    },
    {
      name: 'caps oversized context line requests and reports requested values in the payload',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureMatches(BRACE_SCOPED_TEXT_QUERY);
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain text matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_TEXT_QUERY,
          includePattern: BRACE_SCOPED_QUERY,
          beforeContextLines: BRACE_SCOPED_CONTEXT_CLAMP_BEFORE,
          afterContextLines: BRACE_SCOPED_CONTEXT_CLAMP_AFTER,
          maxResults: 1500,
        });

        assert.equal(payload.beforeContextLines, 50);
        assert.equal(payload.beforeContextLinesRequested, BRACE_SCOPED_CONTEXT_CLAMP_BEFORE);
        assert.equal(payload.afterContextLines, BRACE_SCOPED_CONTEXT_CLAMP_AFTER);
        assert.equal(payload.afterContextLinesRequested, undefined);
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
      },
    },
    {
      name: 'applies mixed scoped and unscoped top-level brace alternation to qgrep text search',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectMixedScopedUnscopedFixtureMatches();
        assert.ok(expectedMatches.length > 0, 'Expected mixed scoped/unscoped fixture to contain text matches.');

        const payload = await executeQgrepSearch({
          query: MIXED_SCOPED_UNSCOPED_TEXT_QUERY,
          includePattern: MIXED_SCOPED_UNSCOPED_QUERY,
          maxResults: 200,
        });

        assert.equal(payload.includePattern, MIXED_SCOPED_UNSCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 200);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'applies top-level pipe alternation as literal union in qgrep text queries',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureMatchesForQueries([
          'BraceWorkspaceSignal',
          'GameSettingRegistry',
        ]);
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain normalized pipe query matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_PIPE_TEXT_QUERY,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 1500,
        });

        assert.equal(payload.query, BRACE_SCOPED_PIPE_TEXT_QUERY);
        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 1500);
        assert.equal(payload.queryHints, undefined);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'matches quoted literal branches containing pipe characters',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureMatches('BraceWorkspaceSignal|GameSettingRegistry');
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain quoted literal pipe matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_QUOTED_PIPE_TEXT_QUERY,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 200,
        });

        assert.equal(payload.query, BRACE_SCOPED_QUOTED_PIPE_TEXT_QUERY);
        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 200);
        assert.equal(payload.queryHints, undefined);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'matches escaped pipe characters inside unquoted literal branches',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureMatches('BraceWorkspaceSignal|GameSettingRegistry');
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain escaped literal pipe matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_ESCAPED_PIPE_TEXT_QUERY,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 200,
        });

        assert.equal(payload.query, BRACE_SCOPED_ESCAPED_PIPE_TEXT_QUERY);
        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 200);
        assert.equal(payload.queryHints, undefined);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'preserves whitespace around literal pipe branches',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectFixtureMatchesInFiles(
          await collectBraceFixtureFilesByWorkspacePathSet(new Set([BRACE_SCOPED_BRIDGE_ANCHOR_FILE])),
          ['SpacePipeLeft ', ' SpacePipeRight'],
        );
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain whitespace-preserving pipe matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_SPACE_PIPE_TEXT_QUERY,
          includePattern: BRACE_SCOPED_BRIDGE_ANCHOR_FILE,
          maxResults: 200,
        });

        assert.equal(payload.query, BRACE_SCOPED_SPACE_PIPE_TEXT_QUERY);
        assert.equal(payload.includePattern, BRACE_SCOPED_BRIDGE_ANCHOR_FILE);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 200);
        assert.equal(payload.queryHints, undefined);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'treats malformed opening double quotes as ordinary characters in literal union queries',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureMatchesForQueries([
          '"BrokenPipeLeft',
          'BrokenPipeRight',
        ]);
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain malformed quote pipe matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_BROKEN_QUOTE_PIPE_TEXT_QUERY,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 200,
        });

        assert.equal(payload.query, BRACE_SCOPED_BROKEN_QUOTE_PIPE_TEXT_QUERY);
        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 200);
        assert.equal(payload.queryHints, undefined);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'falls back to raw literal matching when pipe branches are empty',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureMatches(BRACE_SCOPED_FALLBACK_PIPE_TEXT_QUERY);
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain literal fallback pipe matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_FALLBACK_PIPE_TEXT_QUERY,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 200,
        });

        assert.equal(payload.query, BRACE_SCOPED_FALLBACK_PIPE_TEXT_QUERY);
        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal-fallback');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 200);
        assert.deepEqual(payload.queryHints, [QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK]);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'drops whitespace-only branches between pipe separators',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectFixtureMatchesInFiles(
          await collectBraceFixtureFilesByWorkspacePathSet(new Set([BRACE_SCOPED_BRIDGE_ANCHOR_FILE])),
          ['BrokenPipe', 'Literal'],
        );
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain whitespace-dropped pipe matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_SINGLE_SPACE_PIPE_TEXT_QUERY,
          includePattern: BRACE_SCOPED_BRIDGE_ANCHOR_FILE,
          maxResults: 200,
        });

        assert.equal(payload.query, BRACE_SCOPED_SINGLE_SPACE_PIPE_TEXT_QUERY);
        assert.equal(payload.includePattern, BRACE_SCOPED_BRIDGE_ANCHOR_FILE);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 200);
        assert.deepEqual(payload.queryHints, [QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED]);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'de-duplicates overlapping scoped and unscoped branches in qgrep text search',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectMixedScopedUnscopedOverlapFixtureMatches();
        assert.ok(expectedMatches.length > 0, 'Expected overlap fixture to contain text matches.');

        const payload = await executeQgrepSearch({
          query: MIXED_SCOPED_UNSCOPED_TEXT_QUERY,
          includePattern: MIXED_SCOPED_UNSCOPED_OVERLAP_QUERY,
          maxResults: 200,
        });

        assert.equal(payload.includePattern, MIXED_SCOPED_UNSCOPED_OVERLAP_QUERY);
        assert.equal(payload.querySemanticsApplied, 'literal');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 200);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'rejects explicit text glob mode',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        await assert.rejects(
          () => executeQgrepSearch({
            query: BRACE_SCOPED_TEXT_QUERY,
            querySyntax: 'glob',
            includePattern: BRACE_SCOPED_QUERY,
            maxResults: 20,
          }),
          /querySyntax must be one of: 'literal', 'regex'\./u,
        );
      },
    },
    {
      name: 'applies brace-scoped includePattern filtering to qgrep regex text search with smart-case',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureRegexMatches(BRACE_SCOPED_REGEX_INCLUDE_QUERY);
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain regex text matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_REGEX_INCLUDE_QUERY,
          querySyntax: 'regex',
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 1500,
        });

        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'regex');
        assert.equal(payload.effectiveQuery, undefined);
        assert.equal(payload.warnings, undefined);
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'insensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 1500);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
    {
      name: 'fails fast when includePattern uses pipe alternation',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        await assert.rejects(
          () => executeQgrepSearch({
            query: BRACE_SCOPED_TEXT_QUERY,
            includePattern: 'WorkspaceA/Source/**/*.{h,cpp}|WorkspaceB/Source/**/*.{h,cpp}',
            maxResults: 20,
          }),
          /includePattern does not support '\|' alternation/u,
        );
      },
    },
    {
      name: 'keeps explicit case-sensitive regex text search scoped to brace-selected workspaces',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();
        const expectedMatches = await collectBraceScopedFixtureRegexMatches(
          BRACE_SCOPED_REGEX_GAME_SETTING_QUERY,
          true,
        );
        assert.ok(expectedMatches.length > 0, 'Expected brace-scoped fixture to contain case-sensitive regex matches.');

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_REGEX_GAME_SETTING_QUERY,
          querySyntax: 'regex',
          caseSensitive: true,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 1500,
        });

        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'regex');
        assert.equal(payload.casePolicy, 'explicit-case-sensitive');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, expectedMatches.length);
        assert.equal(payload.totalAvailable, expectedMatches.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 1500);
        assertMatchRecordsMatch(payload, expectedMatches);
      },
    },
  ]);
}
