import { DEFAULT_ALLOWED_PASSTHROUGH_METHODS } from '../methods';
import { ClangdCustomToolDefinition } from '../types';
import {
  astToolSchema,
  inlayHintsToolSchema,
  lspRequestToolSchema,
  memoryUsageToolSchema,
  statusToolSchema,
  switchSourceHeaderToolSchema,
  typeHierarchyResolveToolSchema,
  typeHierarchyToolSchema,
} from '../schemas';
import { runAstTool } from './ast';
import { runInlayHintsTool } from './inlayHints';
import { runLspRequestTool } from './lspRequest';
import { runMemoryUsageTool } from './memoryUsage';
import { runStatusTool } from './status';
import { runSwitchSourceHeaderTool } from './switchSourceHeader';
import { runTypeHierarchyResolveTool, runTypeHierarchyTool } from './typeHierarchy';

export function buildStatusTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_status',
    description: 'Get clangd extension and client status for MCP diagnostics.',
    tags: ['clangd', 'diagnostics'],
    inputSchema: statusToolSchema,
    isCustom: true,
    invoke: runStatusTool,
  };
}

export function buildSwitchSourceHeaderTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_switchSourceHeader',
    description: 'Resolve the paired header/source file using clangd textDocument/switchSourceHeader.',
    tags: ['clangd', 'navigation'],
    inputSchema: switchSourceHeaderToolSchema,
    isCustom: true,
    invoke: runSwitchSourceHeaderTool,
  };
}

export function buildAstTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_ast',
    description: 'Query clangd textDocument/ast for the selected source range.',
    tags: ['clangd', 'ast'],
    inputSchema: astToolSchema,
    isCustom: true,
    invoke: runAstTool,
  };
}

export function buildTypeHierarchyTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_typeHierarchy',
    description: 'Query clangd textDocument/typeHierarchy at a given source position.',
    tags: ['clangd', 'hierarchy'],
    inputSchema: typeHierarchyToolSchema,
    isCustom: true,
    invoke: runTypeHierarchyTool,
  };
}

export function buildTypeHierarchyResolveTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_typeHierarchyResolve',
    description: 'Resolve additional clangd type hierarchy levels using typeHierarchy/resolve.',
    tags: ['clangd', 'hierarchy'],
    inputSchema: typeHierarchyResolveToolSchema,
    isCustom: true,
    invoke: runTypeHierarchyResolveTool,
  };
}

export function buildMemoryUsageTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_memoryUsage',
    description: 'Query clangd memory tree via $/memoryUsage.',
    tags: ['clangd', 'diagnostics'],
    inputSchema: memoryUsageToolSchema,
    isCustom: true,
    invoke: runMemoryUsageTool,
  };
}

export function buildInlayHintsTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_inlayHints',
    description: 'Query clangd inlay hints in a source range via clangd/inlayHints.',
    tags: ['clangd', 'inlayHints'],
    inputSchema: inlayHintsToolSchema,
    isCustom: true,
    invoke: runInlayHintsTool,
  };
}

export function buildLspRequestTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_lspRequest',
    description: `Call an allowed clangd LSP request method. Default allowed methods: ${DEFAULT_ALLOWED_PASSTHROUGH_METHODS.join(', ')}`,
    tags: ['clangd', 'passthrough'],
    inputSchema: lspRequestToolSchema,
    isCustom: true,
    invoke: runLspRequestTool,
  };
}
