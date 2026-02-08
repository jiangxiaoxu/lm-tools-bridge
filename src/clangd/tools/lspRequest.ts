import * as vscode from 'vscode';
import { ClangdToolError } from '../errors';
import { sendRequestWithAutoStart } from '../transport';
import { getEffectiveAllowedPassthroughMethods } from '../client';
import {
  errorResult,
  normalizeLspDataToOneBased,
  normalizeLspDataToZeroBased,
  readOptionalObject,
  readOptionalPositiveInteger,
  readString,
  successTextResult,
} from './shared';

function isMethodAllowed(method: string): boolean {
  const allowed = new Set(getEffectiveAllowedPassthroughMethods());
  return allowed.has(method);
}

export async function runLspRequestTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const method = readString(input, 'method');
    const params = normalizeLspDataToZeroBased(readOptionalObject(input, 'params') ?? {}, 'params');
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
    const normalizedResult = normalizeLspDataToOneBased(result ?? null);
    const text = [
      `counts total=1 shown=1 truncated=false kind=lspRequest method=${method}`,
      '---',
      '[METHOD]',
      method,
      '---',
      '[RESULT]',
      JSON.stringify(normalizedResult, null, 2),
    ].join('\n');
    return successTextResult(text, {
      kind: 'lspRequest',
      method,
      result: normalizedResult,
    });
  } catch (error) {
    return errorResult(error);
  }
}
