import * as vscode from 'vscode';
import { TYPE_HIERARCHY_METHOD, TYPE_HIERARCHY_RESOLVE_METHOD } from '../methods';
import { ClangdToolError } from '../errors';
import { sendRequestWithAutoStart } from '../transport';
import {
  asObject,
  errorResult,
  normalizeLspDataToOneBased,
  normalizeLspDataToZeroBased,
  readOptionalInteger,
  readPositionFromInput,
  readString,
  successResult,
} from './shared';

function normalizeDirection(value: number | undefined, fallback: 0 | 1 | 2): 0 | 1 | 2 {
  if (value === undefined) {
    return fallback;
  }
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new ClangdToolError('INVALID_INPUT', `Invalid direction value '${value}'. Expected 0, 1, or 2.`);
  }
  return value;
}

export async function runTypeHierarchyTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const uri = readString(input, 'uri');
    const position = readPositionFromInput(input, 'position');
    const resolve = readOptionalInteger(input, 'resolve') ?? 5;
    const direction = normalizeDirection(readOptionalInteger(input, 'direction'), 2);
    const result = await sendRequestWithAutoStart<unknown>(TYPE_HIERARCHY_METHOD, {
      textDocument: { uri },
      position,
      resolve,
      direction,
    });
    return successResult({
      uri,
      position: normalizeLspDataToOneBased(position),
      resolve,
      direction,
      item: normalizeLspDataToOneBased(result ?? null),
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function runTypeHierarchyResolveTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const item = normalizeLspDataToZeroBased(asObject(input.item, 'item'), 'item');
    const resolve = readOptionalInteger(input, 'resolve') ?? 1;
    const direction = normalizeDirection(readOptionalInteger(input, 'direction'), 0);
    const result = await sendRequestWithAutoStart<unknown>(TYPE_HIERARCHY_RESOLVE_METHOD, {
      item,
      resolve,
      direction,
    });
    return successResult({
      resolve,
      direction,
      item: normalizeLspDataToOneBased(result ?? null),
    });
  } catch (error) {
    return errorResult(error);
  }
}
