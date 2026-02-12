import type { ClangdCustomToolDefinition } from './types';

export function getClangdToolsSnapshot(): readonly ClangdCustomToolDefinition[] {
  // Clangd MCP tools are hard-disabled by product policy.
  // Keep the previous registration flow below for future rollback reference.
  /*
  import { getEffectiveAllowedPassthroughMethods, isClangdMcpEnabled, isClangdPassthroughEnabled } from './client';
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
  */
  return [];
}
