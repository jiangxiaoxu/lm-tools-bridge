import { getEffectiveAllowedPassthroughMethods, isClangdMcpEnabled, isClangdPassthroughEnabled } from './client';
import type { ClangdCustomToolDefinition } from './types';
import {
  buildCallHierarchyTool,
  buildLspRequestTool,
  buildStatusTool,
  buildSwitchSourceHeaderTool,
  buildSymbolBundleTool,
  buildSymbolImplementationsTool,
  buildSymbolInfoTool,
  buildSymbolReferencesTool,
  buildSymbolSearchTool,
  buildTypeHierarchyTool,
} from './tools';

export function getClangdToolsSnapshot(): readonly ClangdCustomToolDefinition[] {
  if (!isClangdMcpEnabled()) {
    return [];
  }
  const tools: ClangdCustomToolDefinition[] = [
    buildStatusTool(),
    buildSwitchSourceHeaderTool(),
    buildTypeHierarchyTool(),
    buildSymbolSearchTool(),
    buildSymbolBundleTool(),
    buildSymbolInfoTool(),
    buildSymbolReferencesTool(),
    buildSymbolImplementationsTool(),
    buildCallHierarchyTool(),
  ];
  if (isClangdPassthroughEnabled()) {
    const allowlist = getEffectiveAllowedPassthroughMethods();
    if (allowlist.length > 0) {
      tools.push(buildLspRequestTool());
    }
  }
  return tools;
}
