import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'jiangxiaoxu.lm-tools-bridge';

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
  const actualNames = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name);
  assert.deepEqual(actualNames, [...expectedNames]);
}
