import * as vscode from 'vscode';
import { INLAY_HINTS_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import {
  errorResult,
  normalizeLspDataToOneBased,
  readRange,
  readString,
  successResult,
} from './shared';

export async function runInlayHintsTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const uri = readString(input, 'uri');
    const range = readRange(input, 'range');
    const result = await sendRequestWithAutoStart<unknown>(INLAY_HINTS_METHOD, {
      textDocument: { uri },
      range,
    });
    return successResult({
      uri,
      range: normalizeLspDataToOneBased(range),
      hints: normalizeLspDataToOneBased(result ?? []),
    });
  } catch (error) {
    return errorResult(error);
  }
}
