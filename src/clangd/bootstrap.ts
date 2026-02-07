import * as vscode from 'vscode';
import { CLANGD_ACTIVATE_COMMAND } from './methods';
import { ClangdToolError } from './errors';
import {
  assertWorkspaceTrusted,
  getClangdExtension,
  getClangdClient,
  getClangdRequestTimeoutMs,
  isClangdAutoStartOnInvokeEnabled,
} from './client';
import type { ClangdLanguageClient } from './types';

let startupInFlight: Promise<ClangdLanguageClient> | undefined;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClient(timeoutMs: number): Promise<ClangdLanguageClient> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const client = await getClangdClient();
    if (client) {
      return client;
    }
    await delay(150);
  }
  throw new ClangdToolError(
    'CLANGD_START_TIMEOUT',
    `Timed out waiting for clangd client startup after ${timeoutMs}ms.`,
  );
}

async function startAndWait(reason: string): Promise<ClangdLanguageClient> {
  assertWorkspaceTrusted();
  if (!getClangdExtension()) {
    throw new ClangdToolError(
      'CLANGD_EXTENSION_MISSING',
      'clangd extension is not installed: llvm-vs-code-extensions.vscode-clangd.',
    );
  }
  if (!isClangdAutoStartOnInvokeEnabled()) {
    throw new ClangdToolError(
      'CLANGD_START_DISABLED',
      `clangd auto-start is disabled. Cannot start clangd for ${reason}.`,
    );
  }
  await vscode.commands.executeCommand(CLANGD_ACTIVATE_COMMAND);
  return waitForClient(getClangdRequestTimeoutMs());
}

export async function startClangdAndWait(reason: string): Promise<ClangdLanguageClient> {
  if (!startupInFlight) {
    startupInFlight = startAndWait(reason).finally(() => {
      startupInFlight = undefined;
    });
  }
  return startupInFlight;
}

export async function ensureClangdRunning(reason: string): Promise<ClangdLanguageClient> {
  assertWorkspaceTrusted();
  const existing = await getClangdClient();
  if (existing) {
    return existing;
  }
  return startClangdAndWait(reason);
}
