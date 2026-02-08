import * as vscode from 'vscode';
import { getClangdExtension } from '../client';
import {
  getEffectiveAllowedPassthroughMethods,
  getClangdEnableSetting,
  getClangdRequestTimeoutMs,
  isClangdAutoStartOnInvokeEnabled,
  isClangdMcpEnabled,
  isClangdPassthroughEnabled,
  isWorkspaceTrusted,
  getClangdApi,
  getClangdClient,
} from '../client';
import { errorResult, successTextResult } from './shared';

function normalizeClientState(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return 'unknown';
  }
  if (typeof raw === 'number') {
    if (raw === 1) {
      return 'stopped';
    }
    if (raw === 2) {
      return 'starting';
    }
    if (raw === 3) {
      return 'running';
    }
    return `unknown-number-${raw}`;
  }
  return String(raw);
}

export async function runStatusTool(_input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const extension = getClangdExtension();
    const api = await getClangdApi();
    const client = await getClangdClient();
    const payload = {
      clangdMcpEnabled: isClangdMcpEnabled(),
      extensionInstalled: extension !== undefined,
      extensionActive: extension?.isActive ?? false,
      apiAvailable: api !== undefined,
      clientAvailable: client !== undefined,
      clientState: normalizeClientState(client?.state),
      clangdEnableSetting: getClangdEnableSetting(),
      workspaceTrusted: isWorkspaceTrusted(),
      autoStartOnInvoke: isClangdAutoStartOnInvokeEnabled(),
      requestTimeoutMs: getClangdRequestTimeoutMs(),
      passthroughEnabled: isClangdPassthroughEnabled(),
      allowedPassthroughMethods: getEffectiveAllowedPassthroughMethods(),
    };
    const text = [
      'counts total=1 shown=1 truncated=false kind=status',
      '---',
      `clangdMcpEnabled: ${String(payload.clangdMcpEnabled)}`,
      `extensionInstalled: ${String(payload.extensionInstalled)}`,
      `extensionActive: ${String(payload.extensionActive)}`,
      `apiAvailable: ${String(payload.apiAvailable)}`,
      `clientAvailable: ${String(payload.clientAvailable)}`,
      `clientState: ${payload.clientState}`,
      `clangdEnableSetting: ${String(payload.clangdEnableSetting)}`,
      `workspaceTrusted: ${String(payload.workspaceTrusted)}`,
      `autoStartOnInvoke: ${String(payload.autoStartOnInvoke)}`,
      `requestTimeoutMs: ${payload.requestTimeoutMs}`,
      `passthroughEnabled: ${String(payload.passthroughEnabled)}`,
      `allowedPassthroughMethods: ${payload.allowedPassthroughMethods.length > 0 ? payload.allowedPassthroughMethods.join(', ') : '(none)'}`,
    ].join('\n');
    return successTextResult(text, payload);
  } catch (error) {
    return errorResult(error);
  }
}
