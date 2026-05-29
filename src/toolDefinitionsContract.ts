import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const LM_TOOLS_BRIDGE_GET_TOOL_DEFINITIONS_TOOL_NAME = 'lmToolsBridge_getToolDefinitions';
export const LEGACY_LM_GET_TOOL_DEFINITIONS_TOOL_NAME = 'lm_getToolDefinitions';

export const LM_GET_TOOL_DEFINITIONS_DESCRIPTION = [
  'Read ToolDefinitions for bound bridged workspace tools when they are missing or suspected stale.',
  "Before invoking a bridged tool, ensure that tool's ToolDefinition is cached by using this helper once when no valid cached ToolDefinition exists.",
  'Do not request the same tool again while its cached definition is valid; call this again only if the definition is missing or an input schema mismatch suggests it is stale.',
  'Request multiple tool names in one call when possible, and prefer prefetching likely-needed future ToolDefinitions so they can be cached and reused without another lookup.',
  'Unknown or unavailable names are returned in missing.',
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
      description: 'Exact enabled bridged tool names whose definitions are missing, suspected stale, or likely needed soon. Include multiple names in one request when possible; cache each returned ToolDefinition before invocation and reuse valid cached definitions instead of requesting the same tool again.',
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

export interface LmToolDefinitionSource {
  name: string;
  description?: unknown;
  tags?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
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
    description: LM_GET_TOOL_DEFINITIONS_DESCRIPTION,
    inputSchema: LM_GET_TOOL_DEFINITIONS_INPUT_SCHEMA,
    outputSchema: LM_GET_TOOL_DEFINITIONS_OUTPUT_SCHEMA,
  };
}

export function parseRequiredToolDefinitionNames(input: Record<string, unknown>): string[] {
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
    description: typeof tool.description === 'string' ? tool.description : '',
    tags: Array.isArray(tool.tags) ? tool.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    inputSchema: tool.inputSchema ?? null,
  };
  if (tool.outputSchema !== undefined) {
    payload.outputSchema = tool.outputSchema;
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
