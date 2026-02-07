import * as vscode from 'vscode';

export interface ClangdLanguageClient {
  sendRequest<TResult = unknown>(
    method: string,
    params?: unknown,
    token?: vscode.CancellationToken,
  ): Promise<TResult> | Thenable<TResult>;
  state?: unknown;
}

export interface ClangdApiV1 {
  languageClient: ClangdLanguageClient | undefined;
}

export interface ClangdExtensionApi {
  getApi(version: 1): ClangdApiV1;
}

export interface ClangdCustomToolDefinition {
  name: string;
  description: string;
  tags: string[];
  inputSchema: unknown;
  isCustom: true;
  invoke: (input: Record<string, unknown>) => Promise<vscode.LanguageModelToolResult>;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
