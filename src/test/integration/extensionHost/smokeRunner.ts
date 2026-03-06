import * as vscode from 'vscode';
import {
  activateExtension,
  assertCommandRegistered,
  runIntegrationTests,
  waitForWorkspaceFolderNames,
} from './testHarness';

const REQUIRED_COMMANDS = [
  'lm-tools-bridge.qgrepInitAllWorkspaces',
  'lm-tools-bridge.qgrepRebuildIndexes',
  'lm-tools-bridge.qgrepStopAndClearIndexes',
] as const;

export async function run(): Promise<void> {
  await runIntegrationTests('smoke', [
    {
      name: 'activates extension in the repository workspace',
      run: async () => {
        await activateExtension();
      },
    },
    {
      name: 'opens the repository workspace as a single-root workspace',
      run: async () => {
        await waitForWorkspaceFolderNames(['lm-tools-bridge']);
      },
    },
    {
      name: 'registers the qgrep commands needed by the extension',
      run: async () => {
        await activateExtension();
        const commands = await vscode.commands.getCommands(true);
        for (const commandId of REQUIRED_COMMANDS) {
          assertCommandRegistered(commands, commandId);
        }
      },
    },
  ]);
}
