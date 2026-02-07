import * as vscode from 'vscode';
import { maybeErrorText, ClangdToolError } from './errors';
import { ensureClangdRunning, startClangdAndWait } from './bootstrap';
import { getClangdRequestTimeoutMs } from './client';
import type { ClangdLanguageClient } from './types';

interface SendRequestOptions {
  timeoutMs?: number;
  retryOnStartFailure?: boolean;
}

function shouldRetryAfterStart(error: unknown): boolean {
  const text = maybeErrorText(error).toLowerCase();
  return text.includes('not running')
    || text.includes('stopped')
    || text.includes('client is not')
    || text.includes('not initialized');
}

async function sendWithTimeout<TResult>(
  client: ClangdLanguageClient,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<TResult> {
  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => {
    cts.cancel();
  }, timeoutMs);
  try {
    const value = await Promise.resolve(client.sendRequest<TResult>(method, params, cts.token));
    return value;
  } catch (error) {
    if (cts.token.isCancellationRequested) {
      throw new ClangdToolError(
        'REQUEST_TIMEOUT',
        `clangd request timed out after ${timeoutMs}ms for method '${method}'.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    cts.dispose();
  }
}

export async function sendRequestWithAutoStart<TResult>(
  method: string,
  params: unknown,
  options?: SendRequestOptions,
): Promise<TResult> {
  const timeoutMs = options?.timeoutMs ?? getClangdRequestTimeoutMs();
  const retryOnStartFailure = options?.retryOnStartFailure ?? true;
  let client: ClangdLanguageClient;
  try {
    client = await ensureClangdRunning(method);
  } catch (error) {
    throw new ClangdToolError(
      'CLANGD_CLIENT_UNAVAILABLE',
      `Unable to obtain clangd client before '${method}' request: ${maybeErrorText(error)}`,
      error,
    );
  }

  try {
    return await sendWithTimeout<TResult>(client, method, params, timeoutMs);
  } catch (error) {
    if (!retryOnStartFailure || !shouldRetryAfterStart(error)) {
      throw new ClangdToolError(
        'REQUEST_FAILED',
        `clangd request failed for '${method}': ${maybeErrorText(error)}`,
        error,
      );
    }
  }

  try {
    const restartedClient = await startClangdAndWait(method);
    return await sendWithTimeout<TResult>(restartedClient, method, params, timeoutMs);
  } catch (error) {
    throw new ClangdToolError(
      'REQUEST_FAILED',
      `clangd request retry failed for '${method}': ${maybeErrorText(error)}`,
      error,
    );
  }
}
