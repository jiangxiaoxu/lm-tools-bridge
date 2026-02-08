import * as vscode from 'vscode';
import { errorToMessage, ClangdToolError } from '../errors';
import type { LspPosition, LspRange } from '../types';

function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toStructuredPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

export function successResult(payload: unknown): vscode.LanguageModelToolResult {
  const result = {
    content: [new vscode.LanguageModelTextPart(toPrettyJson(payload))],
    structuredContent: toStructuredPayload(payload),
  };
  return result as unknown as vscode.LanguageModelToolResult;
}

export function successTextResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): vscode.LanguageModelToolResult {
  const result = {
    content: [new vscode.LanguageModelTextPart(text)],
  };
  if (structuredContent) {
    (result as { structuredContent?: Record<string, unknown> }).structuredContent = structuredContent;
  }
  return result as unknown as vscode.LanguageModelToolResult;
}

export function successTextWithPayloadResult(
  text: string,
  payload: unknown,
): vscode.LanguageModelToolResult {
  const result = {
    content: [new vscode.LanguageModelTextPart(text)],
    structuredContent: toStructuredPayload(payload),
  };
  return result as unknown as vscode.LanguageModelToolResult;
}

export function errorResult(error: unknown): vscode.LanguageModelToolResult {
  const message = errorToMessage(error);
  return {
    content: [new vscode.LanguageModelTextPart(message)],
  };
}

export function asObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${fieldName}' to be an object.`);
  }
  return value as Record<string, unknown>;
}

export function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${key}' to be a non-empty string.`);
  }
  return value.trim();
}

export function readOptionalObject(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${key}' to be an object when provided.`);
  }
  return value as Record<string, unknown>;
}

export function readOptionalPositiveInteger(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${key}' to be a positive integer when provided.`);
  }
  return value;
}

export function readOptionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${key}' to be an integer when provided.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function convertLineCharacterPair(
  line: number,
  character: number,
  mode: 'toZeroBased' | 'toOneBased',
  fieldName: string,
): { line: number; character: number } {
  if (!Number.isInteger(line) || !Number.isInteger(character)) {
    throw new ClangdToolError(
      'INVALID_INPUT',
      `Expected '${fieldName}.line' and '${fieldName}.character' to be integers.`,
    );
  }
  if (mode === 'toZeroBased') {
    if (line < 1 || character < 1) {
      throw new ClangdToolError(
        'INVALID_INPUT',
        `Expected '${fieldName}.line' and '${fieldName}.character' to be 1-based positive integers.`,
      );
    }
    return {
      line: line - 1,
      character: character - 1,
    };
  }
  return {
    line: line + 1,
    character: character + 1,
  };
}

function convertLspIndexingRecursive(
  value: unknown,
  mode: 'toZeroBased' | 'toOneBased',
  fieldName: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => convertLspIndexingRecursive(item, mode, `${fieldName}[${index}]`));
  }
  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = convertLspIndexingRecursive(nested, mode, `${fieldName}.${key}`);
  }

  const line = value.line;
  const character = value.character;
  if (typeof line === 'number' && typeof character === 'number') {
    const converted = convertLineCharacterPair(line, character, mode, fieldName);
    result.line = converted.line;
    result.character = converted.character;
  }
  return result;
}

export function normalizeLspDataToZeroBased(value: unknown, fieldName = 'payload'): unknown {
  return convertLspIndexingRecursive(value, 'toZeroBased', fieldName);
}

export function normalizeLspDataToOneBased(value: unknown): unknown {
  return convertLspIndexingRecursive(value, 'toOneBased', 'payload');
}

function readPosition(value: unknown, fieldName: string): LspPosition {
  const position = asObject(value, fieldName);
  const line = position.line;
  const character = position.character;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${fieldName}.line' to be a 1-based positive integer.`);
  }
  if (typeof character !== 'number' || !Number.isInteger(character) || character < 1) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${fieldName}.character' to be a 1-based positive integer.`);
  }
  return { line: line - 1, character: character - 1 };
}

export function readRange(input: Record<string, unknown>, key: string): LspRange {
  const rangeValue = input[key];
  const rangeObject = asObject(rangeValue, key);
  return {
    start: readPosition(rangeObject.start, `${key}.start`),
    end: readPosition(rangeObject.end, `${key}.end`),
  };
}

export function readPositionFromInput(input: Record<string, unknown>, key: string): LspPosition {
  return readPosition(input[key], key);
}
