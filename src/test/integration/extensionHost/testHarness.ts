import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';

const EXTENSION_ID = 'jiangxiaoxu.lm-tools-bridge';
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface IntegrationTestCase {
  name: string;
  run: () => Promise<void> | void;
}

export async function runIntegrationTests(
  suiteName: string,
  tests: readonly IntegrationTestCase[],
): Promise<void> {
  const failures: string[] = [];
  for (const test of tests) {
    try {
      await test.run();
      console.log(`[${suiteName}] PASS ${test.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      failures.push(`${test.name}\n${message}`);
      console.error(`[${suiteName}] FAIL ${test.name}\n${message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`[${suiteName}] ${String(failures.length)} test(s) failed.\n\n${failures.join('\n\n')}`);
  }
}

export async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension '${EXTENSION_ID}' was not found.`);
  await extension.activate();
  return extension;
}

export function assertCommandRegistered(commands: readonly string[], commandId: string): void {
  assert.ok(commands.includes(commandId), `Expected command '${commandId}' to be registered.`);
}

export async function waitForWorkspaceFolderNames(expectedNames: readonly string[]): Promise<void> {
  let actualNames: string[] = [];
  const deadline = Date.now() + DEFAULT_WAIT_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    actualNames = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name);
    if (actualNames.length === expectedNames.length && actualNames.every((name, index) => name === expectedNames[index])) {
      return;
    }
    await delay(DEFAULT_POLL_INTERVAL_MS);
  }
  assert.deepEqual(actualNames, [...expectedNames]);
}
