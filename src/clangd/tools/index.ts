import { DEFAULT_ALLOWED_PASSTHROUGH_METHODS } from '../methods';
import { ClangdCustomToolDefinition } from '../types';
import {
  astToolSchema,
  callHierarchyToolSchema,
  inlayHintsToolSchema,
  lspRequestToolSchema,
  memoryUsageToolSchema,
  statusToolSchema,
  switchSourceHeaderToolSchema,
  symbolBundleToolSchema,
  symbolImplementationsToolSchema,
  symbolInfoToolSchema,
  symbolReferencesToolSchema,
  symbolSearchToolSchema,
  typeHierarchyToolSchema,
} from '../schemas';
import { runAstTool } from './ast';
import { runCallHierarchyTool } from './callHierarchy';
import { runInlayHintsTool } from './inlayHints';
import { runLspRequestTool } from './lspRequest';
import { runMemoryUsageTool } from './memoryUsage';
import { runStatusTool } from './status';
import { runSymbolBundleTool } from './symbolBundle';
import { runSwitchSourceHeaderTool } from './switchSourceHeader';
import { runSymbolImplementationsTool } from './symbolImplementations';
import { runSymbolInfoTool } from './symbolInfo';
import { runSymbolReferencesTool } from './symbolReferences';
import { runSymbolSearchTool } from './symbolSearch';
import { runTypeHierarchyTool } from './typeHierarchy';

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
    description: 'Summarize clangd type hierarchy at a position with bounded super/sub type expansion.',
    tags: ['clangd', 'hierarchy'],
    inputSchema: typeHierarchyToolSchema,
    isCustom: true,
    invoke: runTypeHierarchyTool,
  };
}

export function buildSymbolSearchTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_symbolSearch',
    description: 'Search symbols by exact name or regex and return AI-friendly summaries.',
    tags: ['clangd', 'symbols'],
    inputSchema: symbolSearchToolSchema,
    isCustom: true,
    invoke: runSymbolSearchTool,
  };
}

export function buildSymbolInfoTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_symbolInfo',
    description: 'Get definition/declaration/hover/signature summary for a symbol at filePath+position.',
    tags: ['clangd', 'symbols'],
    inputSchema: symbolInfoToolSchema,
    isCustom: true,
    invoke: runSymbolInfoTool,
  };
}

export function buildSymbolBundleTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_symbolBundle',
    description: 'Aggregate symbol info, references, implementations, and call hierarchy in one AI-first response.',
    tags: ['clangd', 'symbols', 'aggregate'],
    inputSchema: symbolBundleToolSchema,
    isCustom: true,
    invoke: runSymbolBundleTool,
  };
}

export function buildSymbolReferencesTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_symbolReferences',
    description: 'List symbol references in AI-friendly summary text.',
    tags: ['clangd', 'references'],
    inputSchema: symbolReferencesToolSchema,
    isCustom: true,
    invoke: runSymbolReferencesTool,
  };
}

export function buildSymbolImplementationsTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_symbolImplementations',
    description: 'List symbol implementation locations in AI-friendly summary text.',
    tags: ['clangd', 'references'],
    inputSchema: symbolImplementationsToolSchema,
    isCustom: true,
    invoke: runSymbolImplementationsTool,
  };
}

export function buildCallHierarchyTool(): ClangdCustomToolDefinition {
  return {
    name: 'lm_clangd_callHierarchy',
    description: 'Get incoming/outgoing call hierarchy summary for symbol at filePath+position.',
    tags: ['clangd', 'hierarchy'],
    inputSchema: callHierarchyToolSchema,
    isCustom: true,
    invoke: runCallHierarchyTool,
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
