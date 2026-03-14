import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  activateExtension,
  assertCommandRegistered,
  runIntegrationTests,
  waitForFileExists,
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
    {
      name: 'publishes a runnable stdio manager to LOCALAPPDATA',
      run: async () => {
        await activateExtension();
        const localAppData = process.env.LOCALAPPDATA;
        const nodePath = process.env.LM_TOOLS_BRIDGE_TEST_NODE_PATH;
        if (!localAppData || !nodePath) {
          throw new Error('Expected LOCALAPPDATA and LM_TOOLS_BRIDGE_TEST_NODE_PATH test env vars.');
        }
        const targetDir = path.join(localAppData, 'lm-tools-bridge');
        const managerPath = path.join(targetDir, 'stdioManager.js');
        const metadataPath = path.join(targetDir, 'metadata.json');
        await waitForFileExists(managerPath);
        await waitForFileExists(metadataPath);
        const metadataText = await fs.promises.readFile(metadataPath, 'utf8');
        if (!metadataText.includes('"managerFileName": "stdioManager.js"')) {
          throw new Error(`Expected metadata.json to describe stdioManager.js.\nActual content:\n${metadataText}`);
        }

        const stderrChunks: string[] = [];
        const transport = new StdioClientTransport({
          command: nodePath,
          args: [managerPath],
          env: process.env as Record<string, string>,
          stderr: 'pipe',
        });
        transport.stderr?.on('data', (chunk) => {
          stderrChunks.push(chunk.toString());
        });
        const client = new Client(
          { name: 'smoke-stdio-manager-check', version: '1.0.0' },
          { capabilities: {} },
        );
        try {
          await client.connect(transport);
          const tools = await client.listTools();
          const toolNames = tools.tools.map((tool) => tool.name);
          if (!toolNames.includes('lmToolsBridge.requestWorkspaceMCPServer')) {
            throw new Error(`Expected requestWorkspace tool in synced manager tools/list.\nActual tools: ${toolNames.join(', ')}`);
          }
          if (!toolNames.includes('lmToolsBridge.callTool')) {
            throw new Error(`Expected callTool helper in synced manager tools/list.\nActual tools: ${toolNames.join(', ')}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          throw new Error(`${message}\nManager stderr:\n${stderrChunks.join('').trim() || '<empty>'}`);
        } finally {
          await client.close().catch(() => undefined);
        }
      },
    },
  ]);
}
