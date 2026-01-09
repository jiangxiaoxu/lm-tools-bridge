import * as vscode from 'vscode';
import * as http from 'node:http';
import { TextDecoder } from 'node:util';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import * as z from 'zod';

const OUTPUT_CHANNEL_NAME = 'LM Tools';
const DUMP_COMMAND_ID = 'lm-tools-dump';
const START_COMMAND_ID = 'lm-tools-mcp.start';
const STOP_COMMAND_ID = 'lm-tools-mcp.stop';
const CONFIGURE_COMMAND_ID = 'lm-tools-mcp.configureTools';
const CONFIG_SECTION = 'lmToolsMcp';
const CONFIG_DISABLED_TOOLS = 'tools.disabled';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 48123;
const DEFAULT_MAX_CHARS = 2000;

type ToolAction = 'listTools' | 'getToolInfo' | 'invokeTool';
type ToolDetail = 'names' | 'summary' | 'full';

interface ToolkitInput {
  action: ToolAction;
  name?: string;
  detail?: ToolDetail;
  input?: Record<string, unknown>;
  maxChars?: number;
  includeBinary?: boolean;
}

interface ServerConfig {
  autoStart: boolean;
  host: string;
  port: number;
}

interface McpServerState {
  server: http.Server;
  host: string;
  port: number;
}

let serverState: McpServerState | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const dumpCommand = vscode.commands.registerCommand(DUMP_COMMAND_ID, () => {
    outputChannel.clear();
    outputChannel.show(true);
    dumpLmTools(outputChannel);
  });
  const startCommand = vscode.commands.registerCommand(START_COMMAND_ID, () => {
    void startMcpServer(outputChannel);
  });
  const stopCommand = vscode.commands.registerCommand(STOP_COMMAND_ID, () => {
    void stopMcpServer(outputChannel);
  });
  const configureCommand = vscode.commands.registerCommand(CONFIGURE_COMMAND_ID, () => {
    void configureExposedTools();
  });
  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(CONFIG_SECTION)) {
      return;
    }

    void reconcileServerState(outputChannel);
  });

  context.subscriptions.push(
    outputChannel,
    dumpCommand,
    startCommand,
    stopCommand,
    configureCommand,
    configWatcher,
    { dispose: () => { void stopMcpServer(outputChannel); } },
  );

  const config = getServerConfig();
  if (config.autoStart) {
    void startMcpServer(outputChannel);
  }
}

export function deactivate(): void {
  if (serverState) {
    try {
      serverState.server.close();
    } catch {
      // Ignore shutdown errors.
    }
    serverState = undefined;
  }
}

function dumpLmTools(channel: vscode.OutputChannel): void {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    channel.appendLine('vscode.lm is not available in this VS Code version.');
    return;
  }

  const tools = lm.tools;
  if (tools.length === 0) {
    channel.appendLine('No tools found in vscode.lm.tools.');
    return;
  }

  channel.appendLine(`Found ${tools.length} tool(s):`);
  channel.appendLine('');

  for (let i = 0; i < tools.length; i += 1) {
    const tool = tools[i];
    channel.appendLine(`Tool ${i + 1}:`);
    channel.appendLine(`  name: ${tool.name}`);
    channel.appendLine(`  description: ${tool.description}`);
    channel.appendLine(`  tags: ${formatTags(tool.tags)}`);
    channel.appendLine('  inputSchema:');
    channel.appendLine(indentLines(formatSchema(tool.inputSchema), 4));

    if (i < tools.length - 1) {
      channel.appendLine('');
    }
  }
}

function getServerConfig(): ServerConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    autoStart: config.get<boolean>('server.autoStart', true),
    host: config.get<string>('server.host', DEFAULT_HOST),
    port: config.get<number>('server.port', DEFAULT_PORT),
  };
}

function getDisabledTools(): string[] {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const disabled = config.get<string[]>(CONFIG_DISABLED_TOOLS, []);
  return Array.isArray(disabled) ? disabled.filter((name) => typeof name === 'string') : [];
}

async function setDisabledTools(disabled: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(CONFIG_DISABLED_TOOLS, disabled, vscode.ConfigurationTarget.Global);
}

async function configureExposedTools(): Promise<void> {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    void vscode.window.showWarningMessage('vscode.lm is not available in this VS Code version.');
    return;
  }

  const tools = lm.tools;
  if (tools.length === 0) {
    void vscode.window.showInformationMessage('No tools found in vscode.lm.tools.');
    return;
  }

  const disabledSet = new Set(getDisabledTools());
  const items: Array<vscode.QuickPickItem & { toolName?: string; isReset?: boolean }> = [];

  items.push({
    label: '$(refresh) Reset (enable all)',
    description: 'Clear disabled list',
    alwaysShow: true,
    isReset: true,
  });
  items.push({ label: 'Tools', kind: vscode.QuickPickItemKind.Separator });

  for (const tool of tools) {
    items.push({
      label: tool.name,
      description: tool.description,
      detail: tool.tags.length > 0 ? tool.tags.join(', ') : undefined,
      picked: !disabledSet.has(tool.name),
      toolName: tool.name,
    });
  }

  const selections = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Configure exposed LM tools',
    placeHolder: 'Select tools to expose to MCP',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selections) {
    return;
  }

  const shouldReset = selections.some((item) => item.isReset);
  if (shouldReset) {
    await setDisabledTools([]);
    void vscode.window.showInformationMessage('All LM tools are enabled for MCP.');
    return;
  }

  const selectedNames = new Set(
    selections
      .map((item) => item.toolName)
      .filter((name): name is string => typeof name === 'string'),
  );

  const disabled = tools
    .map((tool) => tool.name)
    .filter((name) => !selectedNames.has(name));

  await setDisabledTools(disabled);
  void vscode.window.showInformationMessage(`Disabled ${disabled.length} LM tool(s) from MCP.`);
}

async function reconcileServerState(channel: vscode.OutputChannel): Promise<void> {
  const config = getServerConfig();
  if (!config.autoStart) {
    await stopMcpServer(channel);
    return;
  }

  if (!serverState) {
    await startMcpServer(channel);
    return;
  }

  if (serverState.host !== config.host || serverState.port !== config.port) {
    await stopMcpServer(channel);
    await startMcpServer(channel);
  }
}

async function startMcpServer(channel: vscode.OutputChannel): Promise<void> {
  if (serverState) {
    channel.appendLine(`MCP server already running at http://${serverState.host}:${serverState.port}/mcp`);
    return;
  }

  const { host, port } = getServerConfig();
  const server = http.createServer((req, res) => {
    void handleMcpHttpRequest(req, res, channel);
  });

  await new Promise<void>((resolve) => {
    server.once('error', (error) => {
      channel.appendLine(`Failed to start MCP server: ${String(error)}`);
      resolve();
    });
    server.listen(port, host, () => {
      serverState = { server, host, port };
      channel.appendLine(`MCP server listening at http://${host}:${port}/mcp`);
      resolve();
    });
  });
}

async function stopMcpServer(channel: vscode.OutputChannel): Promise<void> {
  if (!serverState) {
    return;
  }

  const { server, host, port } = serverState;
  serverState = undefined;
  await new Promise<void>((resolve) => {
    server.close(() => {
      channel.appendLine(`MCP server stopped at http://${host}:${port}/mcp`);
      resolve();
    });
  });
}

async function handleMcpHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  channel: vscode.OutputChannel,
): Promise<void> {
  const requestUrl = getRequestUrl(req);
  if (!requestUrl || requestUrl.pathname !== '/mcp') {
    respondJson(res, 404, { error: 'Not Found' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    respondJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const server = createMcpServer(channel);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  transport.onerror = (error) => {
    channel.appendLine(`MCP transport error: ${String(error)}`);
  };

  try {
    await server.connect(transport);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res);
  } catch (error) {
    channel.appendLine(`MCP request failed: ${String(error)}`);
    if (!res.headersSent) {
      respondJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

function createMcpServer(channel: vscode.OutputChannel): McpServer {
  const server = new McpServer(
    {
      name: 'vscode-lm-toolkit',
      version: '0.1.0',
    },
    {
      capabilities: { logging: {} },
    },
  );

  const actionSchema = z.enum(['listTools', 'getToolInfo', 'invokeTool']);
  const detailSchema = z.enum(['names', 'summary', 'full']);

  const toolkitSchema: z.ZodTypeAny = z.object({
    action: actionSchema,
    name: z.string().min(1).optional(),
    detail: detailSchema.optional(),
    input: z.record(z.unknown()).optional(),
    maxChars: z.number().int().min(0).optional(),
    includeBinary: z.boolean().optional(),
  });

  // @ts-expect-error TS2589: Deep instantiation from SDK tool generics.
  server.registerTool<z.ZodTypeAny, z.ZodTypeAny>(
    'vscodeLmToolkit',
    {
      description: 'Access vscode.lm.tools and invoke a specific tool.',
      inputSchema: toolkitSchema,
    },
    async (args: ToolkitInput) => {
      try {
        const lm = getLanguageModelNamespace();
        if (!lm) {
          return toolErrorResult('vscode.lm is not available in this VS Code version.');
        }
        const disabledSet = new Set(getDisabledTools());
        const exposedTools = lm.tools.filter((tool) => !disabledSet.has(tool.name));

        if (args.action === 'listTools') {
          const detail = args.detail ?? 'names';
          const payload = listToolsPayload(exposedTools, detail);
          return toolSuccessResult(payload);
        }

        if (!args.name) {
          return toolErrorResult('Missing required field: name.');
        }

        if (disabledSet.has(args.name)) {
          return toolErrorResult(`Tool is disabled by configuration: ${args.name}`);
        }

        const tool = lm.tools.find((candidate) => candidate.name === args.name);
        if (!tool) {
          return toolErrorResult(`Tool not found: ${args.name}`);
        }

        if (args.action === 'getToolInfo') {
          const detail = args.detail ?? 'full';
          const payload = toolInfoPayload(tool, detail);
          return toolSuccessResult(payload);
        }

        if (args.action === 'invokeTool') {
          if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
            return toolErrorResult('Missing or invalid input object for invokeTool.');
          }

          const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
          const includeBinary = args.includeBinary ?? false;
          const result = await lm.invokeTool(tool.name, {
            toolInvocationToken: undefined,
            input: args.input,
          });
          const serialized = serializeToolResult(result, { maxChars, includeBinary });
          return toolSuccessResult({
            name: tool.name,
            content: serialized,
          });
        }

        return toolErrorResult(`Unsupported action: ${args.action}`);
      } catch (error) {
        channel.appendLine(`Tool invocation error: ${String(error)}`);
        return toolErrorResult(`Tool execution failed: ${String(error)}`);
      }
    },
  );

  server.registerResource(
    'lm-tools-names',
    'lm-tools://names',
    {
      description: 'List of available LM tool names.',
      mimeType: 'application/json',
    },
    async () => {
      const tools = getExposedLmToolsSnapshot();
      return resourceJson('lm-tools://names', { tools: tools.map((tool) => tool.name) });
    },
  );

  server.registerResource(
    'lm-tools-list',
    'lm-tools://list',
    {
      description: 'List of LM tools (name, description, tags).',
      mimeType: 'application/json',
    },
    async () => {
      const tools = getExposedLmToolsSnapshot();
      return resourceJson('lm-tools://list', listToolsPayload(tools, 'summary'));
    },
  );

  server.registerResource(
    'lm-tools-tool',
    new ResourceTemplate('lm-tools://tool/{name}', { list: undefined }),
    {
      description: 'LM tool details by name.',
      mimeType: 'application/json',
    },
    async (_uri, variables) => {
      const name = readTemplateVariable(variables, 'name');
      if (!name) {
        throw new Error('Missing tool name in resource URI.');
      }
      const tools = getAllLmToolsSnapshot();
      if (isToolDisabled(name)) {
        throw new Error(`Tool is disabled by configuration: ${name}`);
      }
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Tool not found: ${name}`);
      }

      return resourceJson(`lm-tools://tool/${name}`, toolInfoPayload(tool, 'full'));
    },
  );

  server.registerResource(
    'lm-tools-schema',
    new ResourceTemplate('lm-tools://schema/{name}', { list: undefined }),
    {
      description: 'LM tool input schema by name.',
      mimeType: 'application/json',
    },
    async (_uri, variables) => {
      const name = readTemplateVariable(variables, 'name');
      if (!name) {
        throw new Error('Missing tool name in resource URI.');
      }
      const tools = getAllLmToolsSnapshot();
      if (isToolDisabled(name)) {
        throw new Error(`Tool is disabled by configuration: ${name}`);
      }
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Tool not found: ${name}`);
      }

      return resourceJson(`lm-tools://schema/${name}`, { inputSchema: tool.inputSchema ?? null });
    },
  );

  return server;
}

function toolSuccessResult(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

function toolErrorResult(message: string) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
  };
}

function resourceJson(uri: string, payload: Record<string, unknown>) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload),
      },
    ],
  };
}

function listToolsPayload(tools: readonly vscode.LanguageModelToolInformation[], detail: ToolDetail) {
  if (detail === 'names') {
    return { tools: tools.map((tool) => tool.name) };
  }

  if (detail === 'summary') {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        tags: tool.tags,
      })),
    };
  }

  return {
    tools: tools.map((tool) => toolInfoPayload(tool, 'full')),
  };
}

function toolInfoPayload(tool: vscode.LanguageModelToolInformation, detail: ToolDetail) {
  if (detail === 'summary') {
    return {
      name: tool.name,
      description: tool.description,
      tags: tool.tags,
    };
  }

  if (detail === 'names') {
    return {
      name: tool.name,
    };
  }

  return {
    name: tool.name,
    description: tool.description,
    tags: tool.tags,
    inputSchema: tool.inputSchema ?? null,
  };
}

function serializeToolResult(
  result: vscode.LanguageModelToolResult,
  options: { maxChars: number; includeBinary: boolean },
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const truncated = truncateText(part.value, options.maxChars);
      parts.push({
        type: 'text',
        text: truncated.text,
        truncated: truncated.truncated || undefined,
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelPromptTsxPart) {
      const serialized = safeStringify(part.value);
      const truncated = truncateText(serialized, options.maxChars);
      parts.push({
        type: 'prompt-tsx',
        text: truncated.text,
        truncated: truncated.truncated || undefined,
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      const payload: Record<string, unknown> = {
        type: 'data',
        mimeType: part.mimeType,
        byteLength: part.data.byteLength,
      };

      const decodedText = decodeTextData(part);
      if (decodedText !== undefined) {
        const truncated = truncateText(decodedText, options.maxChars);
        payload.text = truncated.text;
        if (truncated.truncated) {
          payload.textTruncated = true;
        }
      }

      if (options.includeBinary) {
        const base64 = Buffer.from(part.data).toString('base64');
        const truncated = truncateText(base64, options.maxChars);
        payload.dataBase64 = truncated.text;
        if (truncated.truncated) {
          payload.dataTruncated = true;
        }
      }

      parts.push(payload);
      continue;
    }

    const serialized = safeStringify(part);
    const truncated = truncateText(serialized, options.maxChars);
    parts.push({
      type: 'unknown',
      text: truncated.text,
      truncated: truncated.truncated || undefined,
    });
  }

  return parts;
}

function decodeTextData(part: vscode.LanguageModelDataPart): string | undefined {
  if (part.mimeType.startsWith('text/') || part.mimeType === 'application/json') {
    return new TextDecoder('utf-8').decode(part.data);
  }

  return undefined;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }

  return { text: text.slice(0, maxChars), truncated: true };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function getRequestUrl(req: http.IncomingMessage): URL | undefined {
  const host = req.headers.host ?? 'localhost';
  const urlValue = req.url ?? '/';
  try {
    return new URL(urlValue, `http://${host}`);
  } catch {
    return undefined;
  }
}

function respondJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (res.headersSent) {
    return;
  }

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readTemplateVariable(
  variables: Record<string, string | string[]>,
  name: string,
): string | undefined {
  const value = variables[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function getAllLmToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const lm = getLanguageModelNamespace();
  return lm ? lm.tools : [];
}

function getExposedLmToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const tools = getAllLmToolsSnapshot();
  const disabledSet = new Set(getDisabledTools());
  return tools.filter((tool) => !disabledSet.has(tool.name));
}

function isToolDisabled(name: string): boolean {
  const disabled = getDisabledTools();
  return disabled.includes(name);
}

function getLanguageModelNamespace(): typeof vscode.lm | undefined {
  const possibleLm = (vscode as { lm?: typeof vscode.lm }).lm;
  return possibleLm;
}

function formatTags(tags: readonly string[]): string {
  return tags.length > 0 ? tags.join(', ') : '(none)';
}

function formatSchema(schema: object | undefined): string {
  if (!schema) {
    return '(none)';
  }

  return JSON.stringify(schema, null, 2);
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split(/\r?\n/u)
    .map((line) => `${pad}${line}`)
    .join('\n');
}
