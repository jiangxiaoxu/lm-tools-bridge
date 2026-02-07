export type ClangdErrorCode =
  | 'CLANGD_EXTENSION_MISSING'
  | 'CLANGD_CLIENT_UNAVAILABLE'
  | 'CLANGD_START_DISABLED'
  | 'CLANGD_START_TIMEOUT'
  | 'WORKSPACE_UNTRUSTED'
  | 'INVALID_INPUT'
  | 'METHOD_NOT_ALLOWED'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_FAILED';

export class ClangdToolError extends Error {
  public readonly code: ClangdErrorCode;
  public readonly details?: unknown;

  constructor(code: ClangdErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function errorToMessage(error: unknown): string {
  if (error instanceof ClangdToolError) {
    return `[${error.code}] ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function maybeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
