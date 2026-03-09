import assert from 'node:assert/strict';
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
const BRACE_SCOPED_SIGNAL = 'BraceWorkspaceSignal';

const braceScopedFixturePaths = [
  'WorkspaceA/Source/Runtime/Private/ScopeAnchor.cpp',
  'WorkspaceA/Source/Runtime/Public/ScopeAnchor.h',
  'WorkspaceA/Source/Scripting/ScopeAnchor.as',
  'WorkspaceA/Source/Tools/ScopeAnchor.cs',
  'WorkspaceB/Source/Editor/Private/BridgeAnchor.cpp',
  'WorkspaceB/Source/Editor/Public/BridgeAnchor.h',
  'WorkspaceB/Source/Scripting/BridgeAnchor.as',
  'WorkspaceB/Source/Tools/BridgeAnchor.cs',
];

interface QgrepFileRecord {
  absolutePath: string;
  workspacePath: string;
  workspaceFolder: string;
}

interface QgrepMatchRecord extends QgrepFileRecord {
  line: number;
  preview: string;
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/');
}

function getWorkspaceRootMap(): Map<string, string> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return new Map(folders.map((folder) => [folder.name, normalizePath(path.resolve(folder.uri.fsPath))]));
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

function assertFileRecordsMatch(payload: Record<string, unknown>, expectedWorkspacePaths: readonly string[]): void {
  const records = collectFileRecords(payload);
  const roots = getWorkspaceRootMap();
  const actualPaths = records.map((record) => record.workspacePath).sort();
  assert.deepEqual(actualPaths, [...expectedWorkspacePaths].sort());

  const recordsByWorkspacePath = new Map(records.map((record) => [record.workspacePath, record]));
  for (const expectedWorkspacePath of expectedWorkspacePaths) {
    const record = recordsByWorkspacePath.get(expectedWorkspacePath);
    assert.ok(record, `Expected file result '${expectedWorkspacePath}' to be present.`);

    const [workspaceFolder, ...relativeSegments] = expectedWorkspacePath.split('/');
    assert.equal(record.workspaceFolder, workspaceFolder);

    const workspaceRoot = roots.get(workspaceFolder);
    assert.ok(workspaceRoot, `Expected workspace root for '${workspaceFolder}'.`);

    const expectedAbsolutePath = normalizePath(path.join(workspaceRoot, ...relativeSegments));
    assert.equal(record.absolutePath, expectedAbsolutePath);
  }
}

function assertMatchRecordsMatch(payload: Record<string, unknown>, expectedWorkspacePaths: readonly string[]): void {
  const records = collectMatchRecords(payload);
  const actualPaths = records.map((record) => record.workspacePath).sort();
  assert.deepEqual(actualPaths, [...expectedWorkspacePaths].sort());

  for (const record of records) {
    assert.equal(record.line, 1, `Expected '${record.workspacePath}' to match on line 1.`);
    assert.ok(record.preview.includes(BRACE_SCOPED_SIGNAL), `Expected preview for '${record.workspacePath}' to contain the brace-scoped signal.`);
  }
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

        const payload = await executeQgrepFilesSearch({
          query: BRACE_SCOPED_QUERY,
          maxResults: 20,
        });

        assert.equal(payload.scope, '{WorkspaceA,WorkspaceB}');
        assert.equal(payload.querySemanticsApplied, 'glob-vscode');
        assert.equal(payload.count, braceScopedFixturePaths.length);
        assert.equal(payload.totalAvailable, braceScopedFixturePaths.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 20);
        assertFileRecordsMatch(payload, braceScopedFixturePaths);
      },
    },
    {
      name: 'applies brace-scoped includePattern filtering to qgrep text search',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepSearch({
          query: BRACE_SCOPED_SIGNAL,
          includePattern: BRACE_SCOPED_QUERY,
          maxResults: 20,
        });

        assert.equal(payload.includePattern, BRACE_SCOPED_QUERY);
        assert.equal(payload.querySemanticsApplied, 'glob');
        assert.equal(payload.casePolicy, 'smart-case');
        assert.equal(payload.caseModeApplied, 'sensitive');
        assert.equal(payload.count, braceScopedFixturePaths.length);
        assert.equal(payload.totalAvailable, braceScopedFixturePaths.length);
        assert.equal(payload.capped === true, false);
        assert.equal(payload.totalAvailableCapped === true, false);
        assert.equal(payload.hardLimitHit === true, false);
        assert.equal(payload.maxResultsApplied, 20);
        assertMatchRecordsMatch(payload, braceScopedFixturePaths);
      },
    },
  ]);
}
