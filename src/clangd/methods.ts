export const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';
export const CLANGD_API_VERSION = 1 as const;
export const CLANGD_ACTIVATE_COMMAND = 'clangd.activate';

export const SWITCH_SOURCE_HEADER_METHOD = 'textDocument/switchSourceHeader';
export const AST_METHOD = 'textDocument/ast';
export const TYPE_HIERARCHY_METHOD = 'textDocument/typeHierarchy';
export const TYPE_HIERARCHY_RESOLVE_METHOD = 'typeHierarchy/resolve';
export const MEMORY_USAGE_METHOD = '$/memoryUsage';
export const INLAY_HINTS_METHOD = 'clangd/inlayHints';

export const DEFAULT_ALLOWED_PASSTHROUGH_METHODS = [
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/references',
  'textDocument/documentSymbol',
  'workspace/symbol',
  'textDocument/signatureHelp',
  SWITCH_SOURCE_HEADER_METHOD,
  AST_METHOD,
  TYPE_HIERARCHY_METHOD,
  TYPE_HIERARCHY_RESOLVE_METHOD,
] as const;
