import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  requestWorkspaceDiscovery,
  resolveWorkspaceDiscoveryTargetFromWindow,
} from '../../../workspaceDiscovery';
import {
  activateExtension,
  assertCommandRegistered,
  runIntegrationTests,
  waitForFileExists,
  waitForWorkspaceFolderNames,
} from './testHarness';
import { buildToolInputSchema, getEnabledExposedToolsSnapshot } from '../../../tooling';

const REQUIRED_COMMANDS = [
  'lm-tools-bridge.qgrepInitAllWorkspaces',
  'lm-tools-bridge.qgrepRebuildIndexes',
  'lm-tools-bridge.qgrepStopAndClearIndexes',
] as const;
const AUTO_START_WAIT_TIMEOUT_MS = 10_000;
const AUTO_START_POLL_INTERVAL_MS = 100;

async function requestJson(url: string): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.once('error', reject);
  });
}

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
      name: 'exposes lm_getDiagnostics with includePattern-based input schema',
      run: async () => {
        await activateExtension();
        const tool = getEnabledExposedToolsSnapshot().find((candidate) => candidate.name === 'lm_getDiagnostics');
        if (!tool) {
          throw new Error('Expected lm_getDiagnostics to be enabled.');
        }
        const inputSchema = buildToolInputSchema(tool);
        if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
          throw new Error('Expected lm_getDiagnostics input schema to be an object.');
        }
        const schemaRecord = inputSchema as {
          properties?: Record<string, unknown>;
        };
        const properties = schemaRecord.properties;
        if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
          throw new Error('Expected lm_getDiagnostics input schema properties.');
        }
        if (!Object.prototype.hasOwnProperty.call(properties, 'includePattern')) {
          throw new Error('Expected lm_getDiagnostics schema to expose includePattern.');
        }
        if (Object.prototype.hasOwnProperty.call(properties, 'filePaths')) {
          throw new Error('Expected lm_getDiagnostics schema to remove filePaths.');
        }
      },
    },
    {
      name: 'starts the workspace MCP server automatically on activation',
      run: async () => {
        await activateExtension();
        const target = resolveWorkspaceDiscoveryTargetFromWindow(
          (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
          vscode.workspace.workspaceFile?.fsPath,
        );
        if (!target || 'code' in target) {
          throw new Error('Expected a supported workspace discovery target for the smoke workspace.');
        }
        const deadline = Date.now() + AUTO_START_WAIT_TIMEOUT_MS;
        let advertisement: Awaited<ReturnType<typeof requestWorkspaceDiscovery>> | undefined;
        while (Date.now() <= deadline) {
          advertisement = await requestWorkspaceDiscovery(target, 'smoke-auto-start-check');
          if (advertisement) {
            break;
          }
          await delay(AUTO_START_POLL_INTERVAL_MS);
        }
        if (!advertisement) {
          throw new Error('Expected workspace discovery advertisement after activation.');
        }
        const response = await requestJson(`http://${advertisement.host}:${String(advertisement.port)}/mcp/health`);
        if (response.statusCode !== 200) {
          throw new Error(`Expected /mcp/health to return 200, got ${String(response.statusCode)}.\nBody:\n${response.body}`);
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
