import * as vscode from 'vscode';
import { errorToMessage, ClangdToolError } from '../errors';
import type { LspPosition, LspRange } from '../types';

function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function successResult(payload: unknown): vscode.LanguageModelToolResult {
  return {
    content: [new vscode.LanguageModelTextPart(toPrettyJson(payload))],
  };
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

function readPosition(value: unknown, fieldName: string): LspPosition {
  const position = asObject(value, fieldName);
  const line = position.line;
  const character = position.character;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${fieldName}.line' to be a non-negative integer.`);
  }
  if (typeof character !== 'number' || !Number.isInteger(character) || character < 0) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${fieldName}.character' to be a non-negative integer.`);
  }
  return { line, character };
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
