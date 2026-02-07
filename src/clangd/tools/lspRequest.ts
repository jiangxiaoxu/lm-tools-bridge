import * as vscode from 'vscode';
import { ClangdToolError } from '../errors';
import { sendRequestWithAutoStart } from '../transport';
import { getEffectiveAllowedPassthroughMethods } from '../client';
import {
  errorResult,
  readOptionalObject,
  readOptionalPositiveInteger,
  readString,
  successResult,
} from './shared';

function isMethodAllowed(method: string): boolean {
  const allowed = new Set(getEffectiveAllowedPassthroughMethods());
  return allowed.has(method);
}

export async function runLspRequestTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const method = readString(input, 'method');
    const params = readOptionalObject(input, 'params') ?? {};
    const timeoutMs = readOptionalPositiveInteger(input, 'timeoutMs');
    if (!isMethodAllowed(method)) {
      throw new ClangdToolError(
        'METHOD_NOT_ALLOWED',
        `Method '${method}' is not allowed by lmToolsBridge.clangd.allowedMethods.`,
      );
    }
    const result = await sendRequestWithAutoStart<unknown>(method, params, {
      timeoutMs,
    });
    return successResult({
      method,
      result: result ?? null,
    });
  } catch (error) {
    return errorResult(error);
  }
}
