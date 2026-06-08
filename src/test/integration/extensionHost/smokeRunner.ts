import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  activateExtension,
  runIntegrationTests,
  waitForFileExists,
  waitForWorkspaceFolderNames,
} from './testHarness';

function getResourceText(result: Awaited<ReturnType<Client['readResource']>>): string {
  const first = result.contents[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

async function connectPublishedStdioManager(): Promise<{
  client: Client;
  transport: StdioClientTransport;
  stderrChunks: string[];
}> {
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
  await client.connect(transport);
  return { client, transport, stderrChunks };
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
      name: 'controls the workspace through the stdio manager MCP',
      run: async () => {
        await activateExtension();
        const { client, transport, stderrChunks } = await connectPublishedStdioManager();
        try {
          const tools = await client.listTools();
          const toolNames = tools.tools.map((tool) => tool.name);
          if (!toolNames.includes('lmToolsBridge_bindWorkspace')) {
            throw new Error(`Expected requestWorkspace tool in synced manager tools/list.\nActual tools: ${toolNames.join(', ')}`);
          }
          if (!toolNames.includes('lmToolsBridge_callBridgedTool')) {
            throw new Error(`Expected callBridgedTool helper in synced manager tools/list.\nActual tools: ${toolNames.join(', ')}`);
          }
          if (!toolNames.includes('lmToolsBridge_getToolDefinitions')) {
            throw new Error(`Expected getToolDefinitions helper in synced manager tools/list.\nActual tools: ${toolNames.join(', ')}`);
          }
          if (toolNames.some((name) => !name.startsWith('lmToolsBridge_'))) {
            throw new Error(`Expected only stdio helper tools before bind.\nActual tools: ${toolNames.join(', ')}`);
          }

          const guide = await client.readResource({ uri: 'lm-tools://guide' });
          const guideText = getResourceText(guide);
          if (!guideText.includes('Workspace bridge guide') || !guideText.includes('Shared pathScope syntax')) {
            throw new Error(`Expected stdio manager guide to include bridge and pathScope guidance.\nGuide:\n${guideText}`);
          }
          const workspaceTarget = vscode.workspace.workspaceFile?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!workspaceTarget) {
            throw new Error('Expected an open workspace target for stdio manager bind smoke.');
          }
          const handshake = await client.callTool({
            name: 'lmToolsBridge_bindWorkspace',
            arguments: {
              title: 'Bind workspace',
              cwd: workspaceTarget,
            },
          });
          const handshakePayload = handshake.structuredContent as {
            ok?: unknown;
            discovery?: { bridgedTools?: Array<{ name?: unknown }> };
          } | undefined;
          if (handshakePayload?.ok !== true) {
            throw new Error(`Expected stdio manager bind handshake to succeed.\nPayload:\n${JSON.stringify(handshakePayload, null, 2)}`);
          }
          const bridgedTools = handshakePayload.discovery?.bridgedTools?.map((tool) => tool.name);
          if (!bridgedTools?.includes('lm_getDiagnostics')) {
            throw new Error(`Expected stdio manager bind discovery to include lm_getDiagnostics.\nBridged tools: ${JSON.stringify(bridgedTools)}`);
          }
          const invalidBridgedTools = (bridgedTools ?? []).filter((name) => typeof name !== 'string' || !name.startsWith('lm_'));
          if (invalidBridgedTools.length > 0) {
            throw new Error(`Expected stdio manager bridged discovery to expose only lm_ names.\nInvalid tools: ${invalidBridgedTools.join(', ')}`);
          }

          const afterBindTools = await client.listTools();
          const afterBindToolNames = afterBindTools.tools.map((tool) => tool.name);
          if (!afterBindToolNames.includes('lm_getDiagnostics')) {
            throw new Error(`Expected stdio manager tools/list to include lm_getDiagnostics after bind.\nActual tools: ${afterBindToolNames.join(', ')}`);
          }
          const definitions = await client.callTool({
            name: 'lmToolsBridge_getToolDefinitions',
            arguments: {
              title: 'Get tool definitions',
              names: ['lm_getDiagnostics'],
            },
          });
          const definitionsPayload = definitions.structuredContent as {
            tools?: Array<{ name?: unknown; inputSchema?: unknown }>;
          } | undefined;
          const diagnosticsDefinition = definitionsPayload?.tools?.find((tool) => tool.name === 'lm_getDiagnostics');
          const inputSchema = diagnosticsDefinition?.inputSchema;
          if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
            throw new Error(`Expected lm_getDiagnostics definition to include an object inputSchema.\nPayload:\n${JSON.stringify(definitionsPayload, null, 2)}`);
          }
          const properties = (inputSchema as { properties?: unknown }).properties;
          if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
            throw new Error(`Expected lm_getDiagnostics inputSchema to expose properties.\nPayload:\n${JSON.stringify(definitionsPayload, null, 2)}`);
          }
          const pathScope = (properties as { pathScope?: unknown }).pathScope;
          if (!pathScope || typeof pathScope !== 'object' || Array.isArray(pathScope)) {
            throw new Error(`Expected lm_getDiagnostics.pathScope schema.\nPayload:\n${JSON.stringify(definitionsPayload, null, 2)}`);
          }
          const pathScopeRecord = pathScope as { description?: unknown };
          if (Object.prototype.hasOwnProperty.call(pathScopeRecord, 'x-lm-tools-bridge-sharedSyntax')) {
            throw new Error('Expected lm_getDiagnostics.pathScope schema to omit shared syntax metadata.');
          }
          if (Object.prototype.hasOwnProperty.call(pathScopeRecord, 'minLength')) {
            throw new Error('Expected lm_getDiagnostics.pathScope schema to omit minLength because pathScope is optional.');
          }
          if (Object.prototype.hasOwnProperty.call(pathScopeRecord, 'pattern')) {
            throw new Error('Expected lm_getDiagnostics.pathScope schema to omit pattern because pathScope is optional.');
          }
          const description = typeof pathScopeRecord.description === 'string' ? pathScopeRecord.description : '';
          if (!description.includes('Applies only to arguments named pathScope')) {
            throw new Error(`Expected pathScope description to include compact syntax scope.\nDescription:\n${description}`);
          }
          if (!description.includes('Full syntax is available in lm-tools://guide')) {
            throw new Error(`Expected pathScope description to reference lm-tools://guide.\nDescription:\n${description}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          throw new Error(`${message}\nManager stderr:\n${stderrChunks.join('').trim() || '<empty>'}`);
        } finally {
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        }
      },
    },
  ]);
}
