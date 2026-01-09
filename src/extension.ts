import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'LM Tools';
const COMMAND_ID = 'lm-tools-dump';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const command = vscode.commands.registerCommand(COMMAND_ID, () => {
    outputChannel.clear();
    outputChannel.show(true);
    dumpLmTools(outputChannel);
  });

  context.subscriptions.push(outputChannel, command);
}

export function deactivate(): void {
  // No-op.
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
