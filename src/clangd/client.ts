import * as vscode from 'vscode';
import { getConfigValue } from '../configuration';
import { CLANGD_API_VERSION, CLANGD_EXTENSION_ID, DEFAULT_ALLOWED_PASSTHROUGH_METHODS } from './methods';
import { ClangdToolError } from './errors';
import type { ClangdApiV1, ClangdExtensionApi, ClangdLanguageClient } from './types';

export function isClangdMcpEnabled(): boolean {
  // Deprecated hard-disable.
  // return getConfigValue<boolean>('clangd.enabled', false);
  return false;
}

export function isClangdPassthroughEnabled(): boolean {
  // Deprecated hard-disable.
  // return getConfigValue<boolean>('clangd.enablePassthrough', true);
  return false;
}

export function isClangdAutoStartOnInvokeEnabled(): boolean {
  // Deprecated hard-disable.
  // return getConfigValue<boolean>('clangd.autoStartOnInvoke', true);
  return false;
}

export function getClangdRequestTimeoutMs(): number {
  const configured = getConfigValue<number>('clangd.requestTimeoutMs', 10000);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 10000;
  }
  return Math.floor(configured);
}

export function getAllowedPassthroughMethods(): string[] {
  const configured = getConfigValue<string[]>('clangd.allowedMethods', []);
  if (!Array.isArray(configured)) {
    return [];
  }
  return configured
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function getEffectiveAllowedPassthroughMethods(): string[] {
  const readonlySet = new Set<string>(DEFAULT_ALLOWED_PASSTHROUGH_METHODS);
  const configured = getAllowedPassthroughMethods();
  if (configured.length > 0) {
    const filtered = configured.filter((method) => readonlySet.has(method));
    return [...new Set(filtered)];
  }
  return [...DEFAULT_ALLOWED_PASSTHROUGH_METHODS];
}

export function getClangdEnableSetting(): boolean {
  return vscode.workspace.getConfiguration('clangd').get<boolean>('enable', true);
}

export function isWorkspaceTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

export function getClangdExtension(): vscode.Extension<ClangdExtensionApi> | undefined {
  return vscode.extensions.getExtension<ClangdExtensionApi>(CLANGD_EXTENSION_ID);
}

export async function getClangdApi(): Promise<ClangdApiV1 | undefined> {
  const extension = getClangdExtension();
  if (!extension) {
    return undefined;
  }
  const activated = extension.isActive ? extension.exports : await extension.activate();
  if (!activated || typeof activated.getApi !== 'function') {
    return undefined;
  }
  try {
    return activated.getApi(CLANGD_API_VERSION);
  } catch {
    return undefined;
  }
}

export async function getClangdClient(): Promise<ClangdLanguageClient | undefined> {
  const api = await getClangdApi();
  return api?.languageClient;
}

export function assertWorkspaceTrusted(): void {
  if (!isWorkspaceTrusted()) {
    throw new ClangdToolError(
      'WORKSPACE_UNTRUSTED',
      'Workspace is untrusted. clangd MCP tools are blocked in untrusted workspaces.',
    );
  }
}
