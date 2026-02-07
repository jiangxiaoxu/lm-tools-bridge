const uriProperty = {
  type: 'string',
  description: 'File URI, for example: file:///path/to/file.cpp',
};

const lspPositionSchema = {
  type: 'object',
  properties: {
    line: { type: 'number', description: '1-based line index.' },
    character: { type: 'number', description: '1-based character index.' },
  },
  required: ['line', 'character'],
};

const lspRangeSchema = {
  type: 'object',
  properties: {
    start: lspPositionSchema,
    end: lspPositionSchema,
  },
  required: ['start', 'end'],
};

export const statusToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export const switchSourceHeaderToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    uri: uriProperty,
  },
  required: ['uri'],
};

export const astToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    uri: uriProperty,
    range: lspRangeSchema,
  },
  required: ['uri', 'range'],
};

export const typeHierarchyToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    uri: uriProperty,
    position: lspPositionSchema,
    resolve: { type: 'number', description: 'Initial hierarchy resolve depth. Default is 5.' },
    direction: { type: 'number', description: '0=children, 1=parents, 2=both. Default is 2.' },
  },
  required: ['uri', 'position'],
};

export const typeHierarchyResolveToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    item: { type: 'object', description: 'Type hierarchy item returned from previous request.' },
    resolve: { type: 'number', description: 'Resolve depth. Default is 1.' },
    direction: { type: 'number', description: '0=children, 1=parents. Default is 0.' },
  },
  required: ['item'],
};

export const memoryUsageToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export const inlayHintsToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    uri: uriProperty,
    range: lspRangeSchema,
  },
  required: ['uri', 'range'],
};

export const lspRequestToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    method: { type: 'string', description: 'LSP method name.' },
    params: { type: 'object', description: 'Request params object using 1-based line/character positions.' },
    timeoutMs: { type: 'number', description: 'Optional per-call timeout in milliseconds.' },
  },
  required: ['method'],
};
