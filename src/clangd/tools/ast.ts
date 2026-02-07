import * as vscode from 'vscode';
import { AST_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { errorResult, readRange, readString, successResult } from './shared';

export async function runAstTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const uri = readString(input, 'uri');
    const range = readRange(input, 'range');
    const result = await sendRequestWithAutoStart<unknown>(AST_METHOD, {
      textDocument: { uri },
      range,
    });
    return successResult({
      uri,
      range,
      ast: result ?? null,
    });
  } catch (error) {
    return errorResult(error);
  }
}
