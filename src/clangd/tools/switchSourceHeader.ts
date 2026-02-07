import * as vscode from 'vscode';
import { SWITCH_SOURCE_HEADER_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { errorResult, readString, successResult } from './shared';

export async function runSwitchSourceHeaderTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const uri = readString(input, 'uri');
    const result = await sendRequestWithAutoStart<string | undefined>(
      SWITCH_SOURCE_HEADER_METHOD,
      { uri },
    );
    return successResult({
      uri,
      sourceUri: result ?? null,
      found: Boolean(result),
    });
  } catch (error) {
    return errorResult(error);
  }
}
