import * as vscode from 'vscode';
import { MEMORY_USAGE_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { errorResult, successResult } from './shared';

export async function runMemoryUsageTool(_input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const result = await sendRequestWithAutoStart<unknown>(MEMORY_USAGE_METHOD, {});
    return successResult({
      memoryUsage: result ?? null,
    });
  } catch (error) {
    return errorResult(error);
  }
}
