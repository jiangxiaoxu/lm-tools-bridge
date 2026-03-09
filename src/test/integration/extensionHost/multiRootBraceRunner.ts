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
  activateExtension,
  runIntegrationTests,
  waitForWorkspaceFolderNames,
} from './testHarness';

const QGREP_READY_TIMEOUT_MS = 30_000;
const QGREP_READY_POLL_INTERVAL_MS = 100;
const BRACE_SCOPED_QUERY = '{WorkspaceA,WorkspaceB}/Source/**/*.{h,cpp,cs,as}';
const BRACE_SCOPED_NORMALIZED_QUERY = '{WorkspaceB,WorkspaceA,WorkspaceB}/Source/**/*.{h,cpp,cs,as}';
const BRACE_SCOPED_TEXT_QUERY = '#include';
const BRACE_SCOPED_REGEX_INCLUDE_QUERY = '#include\\s+"[^"]+"';
const BRACE_SCOPED_REGEX_GAME_SETTING_QUERY = 'GameSetting(Value|Registry)';
const BRACE_WORKSPACE_NAMES = ['WorkspaceA', 'WorkspaceB'];
const BRACE_SCOPED_EXTENSIONS = new Set<string>(['.h', '.cpp', '.cs', '.as']);
const MIN_EXPECTED_BRACE_SCOPED_FILES = 100;
const MIN_EXPECTED_PER_WORKSPACE_FILES = 20;

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

async function collectBraceScopedFixtureMatches(query: string): Promise<ExpectedFixtureMatch[]> {
  const normalizedQuery = query.toLowerCase();
  const matches: ExpectedFixtureMatch[] = [];
  for (const file of await collectBraceScopedFixtureFiles()) {
    const fileText = await fs.promises.readFile(file.absolutePath, 'utf8');
    const lines = fileText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? '';
      if (!lineText.toLowerCase().includes(normalizedQuery)) {
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
        assert.equal(payload.querySemanticsApplied, 'glob');
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
