import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const LM_TOOLS_BRIDGE_GET_TOOL_DEFINITIONS_TOOL_NAME = 'lmToolsBridge_getToolDefinitions';

export const LM_GET_TOOL_DEFINITIONS_DESCRIPTION = [
  'Read ToolDefinitions for bound bridged workspace tools whose definitions are unknown.',
  'Set title to a short user-facing description of this lookup so the tool call is readable in the UI.',
  'Precondition: names contains only exact enabled bridged tool names whose full ToolDefinition is unknown.',
  'Do not include tool names whose full ToolDefinitions are already known from this helper; reuse known ToolDefinitions instead.',
  'For unknown bridged ToolDefinitions, use definitions returned by this helper as the only source of truth and never guess or infer a ToolDefinition or inputSchema from the tool name, prior experience, or similar tools.',
  'If every needed ToolDefinition is already known, skip this helper entirely and invoke the bridged tool with the known ToolDefinition.',
  'Unknown or unavailable names are returned in missing.',
].join(' ');

export const LM_GET_TOOL_DEFINITIONS_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      description: 'Required short user-facing description of this ToolDefinition lookup. Use it as a readable UI title for this helper call.',
    },
    names: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'string',
        minLength: 1,
      },
      description: 'Exact enabled bridged tool names whose full ToolDefinitions are unknown. Before calling this helper, remove names whose ToolDefinitions are already known from this helper. Do not guess or infer ToolDefinitions; reuse known ToolDefinitions instead of requesting them again.',
    },
  },
  required: ['title', 'names'],
};

export const LM_GET_TOOL_DEFINITIONS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    requested: {
      type: 'array',
      items: { type: 'string' },
      description: 'Deduplicated requested tool names, in request order.',
    },
    tools: {
      type: 'array',
      description: 'Full definitions found for requested enabled bridged tools.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          title: {
            type: 'string',
            description: 'Human-readable display name for the target tool.',
          },
          description: { type: 'string' },
          inputSchema: {
            type: 'object',
            description: 'JSON Schema object for the target tool input.',
          },
          outputSchema: {
            type: 'object',
            description: 'JSON Schema object for the target tool structured output when available.',
          },
          annotations: {
            type: 'object',
            description: 'MCP tool annotations when available.',
          },
          _meta: {
            type: 'object',
            description: 'MCP tool metadata, including Apps UI resource metadata when available.',
          },
        },
        required: ['name', 'title', 'description', 'inputSchema'],
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
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface LmToolDefinitionSource {
  name: string;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
}

export interface LmGetToolDefinitionsPayload {
  requested: string[];
  tools: Array<Record<string, unknown>>;
  missing: string[];
  count: number;
  missingCount: number;
}

export function getToolDefinitionsLookupDefinition(): ToolDefinitionsLookupDefinition {
  return {
    name: LM_TOOLS_BRIDGE_GET_TOOL_DEFINITIONS_TOOL_NAME,
    title: 'Get Tool Definitions',
    description: LM_GET_TOOL_DEFINITIONS_DESCRIPTION,
    inputSchema: LM_GET_TOOL_DEFINITIONS_INPUT_SCHEMA,
    outputSchema: LM_GET_TOOL_DEFINITIONS_OUTPUT_SCHEMA,
  };
}

export function parseRequiredToolDefinitionNames(input: Record<string, unknown>): string[] {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'title must be a non-empty string.');
  }

  const value = input.names;
  if (!Array.isArray(value) || value.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'names must be a non-empty array of tool name strings.');
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, `names[${index}] must be a string.`);
    }
    const name = entry.trim();
    if (name.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `names[${index}] must be a non-empty string.`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function buildToolDefinitionPayload(tool: LmToolDefinitionSource): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: tool.name,
    title: typeof tool.title === 'string' && tool.title.trim().length > 0 ? tool.title : tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: tool.inputSchema ?? null,
  };
  if (tool.outputSchema !== undefined) {
    payload.outputSchema = tool.outputSchema;
  }
  if (tool.annotations !== undefined) {
    payload.annotations = tool.annotations;
  }
  if (tool._meta !== undefined) {
    payload._meta = tool._meta;
  }
  return payload;
}

export function buildToolDefinitionsPayload(
  tools: readonly LmToolDefinitionSource[],
  names: readonly string[],
): LmGetToolDefinitionsPayload {
  const toolsByName = new Map<string, LmToolDefinitionSource>();
  for (const tool of tools) {
    toolsByName.set(tool.name, tool);
  }

  const definitions: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  for (const name of names) {
    const tool = toolsByName.get(name);
    if (!tool) {
      missing.push(name);
      continue;
    }
    definitions.push(buildToolDefinitionPayload(tool));
  }

  return {
    requested: [...names],
    tools: definitions,
    missing,
    count: definitions.length,
    missingCount: missing.length,
  };
}

export function formatToolDefinitionsSummary(payload: LmGetToolDefinitionsPayload): string {
  const lines = [
    'Tool definitions',
    `requested: ${String(payload.requested.length)}`,
    `returned: ${String(payload.count)}`,
    `missing: ${String(payload.missingCount)}`,
  ];
  if (payload.tools.length > 0) {
    lines.push('tools:');
    for (const tool of payload.tools) {
      const name = typeof tool.name === 'string' ? tool.name : '<unknown>';
      lines.push(`  - ${name}`);
    }
  }
  if (payload.missing.length > 0) {
    lines.push('missing tools:');
    for (const name of payload.missing) {
      lines.push(`  - ${name}`);
    }
  }
  return lines.join('\n');
}
