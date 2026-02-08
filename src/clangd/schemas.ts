const filePathProperty = {
  type: 'string',
  description: "File path. Supports absolute path (for example G:/Project/Source/Foo.h) or workspace-prefixed path (for example UE5/Engine/Source/... ).",
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
    filePath: filePathProperty,
  },
  required: ['filePath'],
};

export const astToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePath: filePathProperty,
    range: lspRangeSchema,
  },
  required: ['filePath', 'range'],
};

export const typeHierarchyToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePath: filePathProperty,
    position: lspPositionSchema,
    maxSuperDepth: {
      type: 'number',
      description: 'Optional. Maximum number of supertypes to return. Non-negative integer. Default is 3.',
    },
    maxSubDepth: {
      type: 'number',
      description: 'Optional. Maximum depth for subtype tree. Non-negative integer. Default is 2.',
    },
    maxSubBreadth: {
      type: 'number',
      description:
        'Optional. Maximum number of direct children returned per class. Non-negative integer. Default is 10.',
    },
  },
  required: ['filePath', 'position'],
};

export const symbolSearchToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Symbol name query string.' },
    matchMode: {
      type: 'string',
      enum: ['exact', 'regex'],
      description: 'Matching mode. exact compares full name, regex applies JavaScript RegExp.',
    },
    kinds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional symbol kind filter. Example: class, struct, enum, method, function.',
    },
    scopePath: {
      type: 'string',
      description: 'Optional path scope. Supports absolute or workspace-prefixed path.',
    },
    limit: {
      type: 'number',
      description: 'Optional maximum result count. Default is 50. Max is 200.',
    },
  },
  required: ['query'],
};

export const symbolBundleToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: "Optional symbol query. Use with 'matchMode'." },
    matchMode: {
      type: 'string',
      enum: ['exact', 'regex'],
      description: "Optional when query is provided. exact compares full name, regex applies JavaScript RegExp.",
    },
    filePath: filePathProperty,
    position: lspPositionSchema,
    kinds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional kind filter used by query mode.',
    },
    scopePath: {
      type: 'string',
      description: 'Optional path scope used by query mode. Supports absolute or workspace-prefixed path.',
    },
    candidateLimit: {
      type: 'number',
      description: 'Optional maximum candidates from symbol search. Default is 20. Max is 100.',
    },
    candidateIndex: {
      type: 'number',
      description: 'Optional 1-based candidate index to resolve. Default is 1.',
    },
    includeDeclaration: {
      type: 'boolean',
      description: 'Optional. Include declaration in reference lookup. Default is false.',
    },
    referencesLimit: {
      type: 'number',
      description: 'Optional maximum references. Default is 120. Max is 500.',
    },
    implementationsLimit: {
      type: 'number',
      description: 'Optional maximum implementations. Default is 80. Max is 300.',
    },
    includeSnippet: {
      type: 'boolean',
      description: 'Optional. Include snippet in symbol info. Default is true.',
    },
    snippetMaxLines: {
      type: 'number',
      description: 'Optional maximum snippet lines. Default is 20. Max is 120.',
    },
    callDirection: {
      type: 'string',
      enum: ['incoming', 'outgoing', 'both'],
      description: 'Optional call hierarchy direction. Default is both.',
    },
    callMaxDepth: {
      type: 'number',
      description: 'Optional call hierarchy traversal depth. Default is 2. Max is 6.',
    },
    callMaxBreadth: {
      type: 'number',
      description: 'Optional call hierarchy per-node limit. Default is 20. Max is 80.',
    },
  },
};

export const symbolInfoToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePath: filePathProperty,
    position: lspPositionSchema,
    includeSnippet: {
      type: 'boolean',
      description: 'Optional. Include source snippet around resolved definition. Default is true.',
    },
    snippetMaxLines: {
      type: 'number',
      description: 'Optional maximum snippet lines. Default is 20. Max is 120.',
    },
  },
  required: ['filePath', 'position'],
};

export const symbolReferencesToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePath: filePathProperty,
    position: lspPositionSchema,
    includeDeclaration: {
      type: 'boolean',
      description: 'Optional. Include declaration references. Default is false.',
    },
    limit: {
      type: 'number',
      description: 'Optional maximum result count. Default is 200. Max is 500.',
    },
  },
  required: ['filePath', 'position'],
};

export const symbolImplementationsToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePath: filePathProperty,
    position: lspPositionSchema,
    limit: {
      type: 'number',
      description: 'Optional maximum result count. Default is 100. Max is 300.',
    },
  },
  required: ['filePath', 'position'],
};

export const callHierarchyToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePath: filePathProperty,
    position: lspPositionSchema,
    direction: {
      type: 'string',
      enum: ['incoming', 'outgoing', 'both'],
      description: 'Optional direction. Default is both.',
    },
    maxDepth: {
      type: 'number',
      description: 'Optional traversal depth. Default is 2. Max is 6.',
    },
    maxBreadth: {
      type: 'number',
      description: 'Optional per-node edge limit. Default is 20. Max is 80.',
    },
  },
  required: ['filePath', 'position'],
};

export const memoryUsageToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export const inlayHintsToolSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePath: filePathProperty,
    range: lspRangeSchema,
  },
  required: ['filePath', 'range'],
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
