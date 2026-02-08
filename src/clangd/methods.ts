export const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';
export const CLANGD_API_VERSION = 1 as const;
export const CLANGD_ACTIVATE_COMMAND = 'clangd.activate';

export const SWITCH_SOURCE_HEADER_METHOD = 'textDocument/switchSourceHeader';
export const AST_METHOD = 'textDocument/ast';
export const TYPE_HIERARCHY_METHOD = 'textDocument/typeHierarchy';
export const TYPE_HIERARCHY_RESOLVE_METHOD = 'typeHierarchy/resolve';
export const HOVER_METHOD = 'textDocument/hover';
export const DEFINITION_METHOD = 'textDocument/definition';
export const DECLARATION_METHOD = 'textDocument/declaration';
export const TYPE_DEFINITION_METHOD = 'textDocument/typeDefinition';
export const IMPLEMENTATION_METHOD = 'textDocument/implementation';
export const REFERENCES_METHOD = 'textDocument/references';
export const DOCUMENT_SYMBOL_METHOD = 'textDocument/documentSymbol';
export const WORKSPACE_SYMBOL_METHOD = 'workspace/symbol';
export const SIGNATURE_HELP_METHOD = 'textDocument/signatureHelp';
export const PREPARE_CALL_HIERARCHY_METHOD = 'textDocument/prepareCallHierarchy';
export const CALL_HIERARCHY_INCOMING_METHOD = 'callHierarchy/incomingCalls';
export const CALL_HIERARCHY_OUTGOING_METHOD = 'callHierarchy/outgoingCalls';
export const MEMORY_USAGE_METHOD = '$/memoryUsage';
export const INLAY_HINTS_METHOD = 'clangd/inlayHints';

export const DEFAULT_ALLOWED_PASSTHROUGH_METHODS = [
  HOVER_METHOD,
  DEFINITION_METHOD,
  DECLARATION_METHOD,
  TYPE_DEFINITION_METHOD,
  IMPLEMENTATION_METHOD,
  REFERENCES_METHOD,
  DOCUMENT_SYMBOL_METHOD,
  WORKSPACE_SYMBOL_METHOD,
  SIGNATURE_HELP_METHOD,
  SWITCH_SOURCE_HEADER_METHOD,
  AST_METHOD,
  TYPE_HIERARCHY_METHOD,
] as const;
