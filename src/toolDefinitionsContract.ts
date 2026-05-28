export const LM_GET_TOOL_DEFINITIONS_TOOL_NAME = 'lm_getToolDefinitions';

export const LM_GET_TOOL_DEFINITIONS_DESCRIPTION = [
  'Read full definitions for multiple enabled bridged tools in one call after workspace bind.',
  'Before the first call to a bridged tool, use this if that tool definition has not already been fetched.',
  'Batch likely-needed future tool names into the same request when possible.',
  'Unknown, unavailable, or disabled names are returned in missing without failing the whole request.',
].join(' ');

export const LM_GET_TOOL_DEFINITIONS_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    names: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'string',
        minLength: 1,
      },
      description: 'Exact enabled bridged tool names to read. Before calling a bridged tool, include its name if its definition has not already been fetched; batch likely-needed future names when possible.',
    },
  },
  required: ['names'],
};

export const LM_GET_TOOL_DEFINITIONS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    requested: {
      type: 'array',
      items: { type: 'string' },
      description: 'Deduplicated tool names requested by the caller, in request order.',
    },
    tools: {
      type: 'array',
      description: 'Full definitions found for requested enabled bridged tools.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
          inputSchema: {
            type: 'object',
            description: 'JSON Schema object for the target tool input.',
          },
          outputSchema: {
            type: 'object',
            description: 'JSON Schema object for the target tool structured output when available.',
          },
        },
        required: ['name', 'description', 'tags', 'inputSchema'],
      },
    },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: 'Requested names that are unknown, unavailable, or disabled.',
    },
    count: {
      type: 'integer',
      minimum: 0,
      description: 'Number of returned tool definitions.',
    },
    missingCount: {
      type: 'integer',
      minimum: 0,
      description: 'Number of missing requested names.',
    },
  },
  required: ['requested', 'tools', 'missing', 'count', 'missingCount'],
};

export interface ToolDefinitionsLookupDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export function getToolDefinitionsLookupDefinition(): ToolDefinitionsLookupDefinition {
  return {
    name: LM_GET_TOOL_DEFINITIONS_TOOL_NAME,
    description: LM_GET_TOOL_DEFINITIONS_DESCRIPTION,
    inputSchema: LM_GET_TOOL_DEFINITIONS_INPUT_SCHEMA,
    outputSchema: LM_GET_TOOL_DEFINITIONS_OUTPUT_SCHEMA,
  };
}
