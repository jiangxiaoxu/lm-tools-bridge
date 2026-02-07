import { getEffectiveAllowedPassthroughMethods, isClangdMcpEnabled, isClangdPassthroughEnabled } from './client';
import type { ClangdCustomToolDefinition } from './types';
import {
  buildAstTool,
  buildLspRequestTool,
  buildStatusTool,
  buildSwitchSourceHeaderTool,
  buildTypeHierarchyResolveTool,
  buildTypeHierarchyTool,
} from './tools';

export function getClangdToolsSnapshot(): readonly ClangdCustomToolDefinition[] {
  if (!isClangdMcpEnabled()) {
    return [];
  }
  const tools: ClangdCustomToolDefinition[] = [
    buildStatusTool(),
    buildSwitchSourceHeaderTool(),
    buildAstTool(),
    buildTypeHierarchyTool(),
    buildTypeHierarchyResolveTool(),
  ];
  if (isClangdPassthroughEnabled()) {
    const allowlist = getEffectiveAllowedPassthroughMethods();
    if (allowlist.length > 0) {
      tools.push(buildLspRequestTool());
    }
  }
  return tools;
}
