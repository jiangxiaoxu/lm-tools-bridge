import * as vscode from 'vscode';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { TextDecoder } from 'node:util';
import * as path from 'node:path';
import * as z from 'zod';
import { executeFindFilesSearch, executeFindTextInFilesSearch } from './searchTools';
import { resolveInputFilePath, resolveStructuredPath } from './workspacePath';
import { buildGroupedToolSections, type CompiledToolGroupingRule } from './toolGrouping';
import { showToolConfigPanel, type ToolConfigPanelResult } from './toolConfigPanel';
import {
  executeQgrepFilesSearch,
  executeQgrepSearch,
  getQgrepStatusSummary,
  type QgrepStatusSummary,
} from './qgrep';
import {
  CONFIG_SECTION,
  getConfigValue,
  getConfigurationResource,
  resolveToolsConfigTarget,
} from './configuration';

type ToolingLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

let toolingLogger: ToolingLogger = {
  info: (message: string) => console.info(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};

export function setToolingLogger(logger: ToolingLogger): void {
  toolingLogger = logger;
}

const CONFIG_ENABLED_TOOLS = 'tools.enabledDelta';
const CONFIG_DISABLED_TOOLS = 'tools.disabledDelta';
const CONFIG_EXPOSED_TOOLS = 'tools.exposedDelta';
const CONFIG_UNEXPOSED_TOOLS = 'tools.unexposedDelta';
const CONFIG_GROUPING_RULES = 'tools.groupingRules';
const CONFIG_DEBUG = 'debug';
const FIND_FILES_TOOL_NAME = 'lm_findFiles';
const FIND_TEXT_IN_FILES_TOOL_NAME = 'lm_findTextInFiles';
const COPILOT_SEARCH_CODEBASE_TOOL_NAME = 'copilot_searchCodebase';
const COPILOT_SEARCH_CODEBASE_PLACEHOLDER_RESPONSE = 'Here are the full contents of the text files in my workspace:';
const LM_GET_DIAGNOSTICS_TOOL_NAME = 'lm_getDiagnostics';
const LM_TASKS_RUN_BUILD_TOOL_NAME = 'lm_tasks_runBuild';
const LM_TASKS_RUN_TEST_TOOL_NAME = 'lm_tasks_runTest';
const LM_DEBUG_LIST_LAUNCH_CONFIGS_TOOL_NAME = 'lm_debug_listLaunchConfigs';
const LM_DEBUG_START_TOOL_NAME = 'lm_debug_start';
const LM_QGREP_GET_STATUS_TOOL_NAME = 'lm_qgrepGetStatus';
const LM_QGREP_SEARCH_TOOL_NAME = 'lm_qgrepSearchText';
const LM_QGREP_FILES_TOOL_NAME = 'lm_qgrepSearchFiles';
const LM_GET_DIAGNOSTICS_DEFAULT_MAX_RESULTS = 100;
const LM_GET_DIAGNOSTICS_MIN_MAX_RESULTS = 1;
const LM_GET_DIAGNOSTICS_PREVIEW_MAX_LINES = 10;
const LM_GET_DIAGNOSTICS_ALLOWED_SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;
type LmGetDiagnosticsSeverity = typeof LM_GET_DIAGNOSTICS_ALLOWED_SEVERITIES[number];
const LM_GET_DIAGNOSTICS_DEFAULT_SEVERITIES: readonly LmGetDiagnosticsSeverity[] = ['error', 'warning'];
const DEFAULT_ENABLED_TOOL_NAMES = [
  'copilot_searchCodebase',
  'copilot_searchWorkspaceSymbols',
  'copilot_listCodeUsages',
  'lm_getDiagnostics',
  LM_QGREP_GET_STATUS_TOOL_NAME,
  LM_QGREP_SEARCH_TOOL_NAME,
  LM_QGREP_FILES_TOOL_NAME,
];
const DEFAULT_EXPOSED_TOOL_NAMES = [
  ...DEFAULT_ENABLED_TOOL_NAMES,
  FIND_FILES_TOOL_NAME,
  FIND_TEXT_IN_FILES_TOOL_NAME,
  LM_TASKS_RUN_BUILD_TOOL_NAME,
  LM_TASKS_RUN_TEST_TOOL_NAME,
  LM_DEBUG_LIST_LAUNCH_CONFIGS_TOOL_NAME,
  LM_DEBUG_START_TOOL_NAME,
];
const REQUIRED_EXPOSED_TOOL_NAMES = DEFAULT_ENABLED_TOOL_NAMES;
const BUILTIN_DISABLED_TOOL_NAMES = [
  'copilot_applyPatch',
  'copilot_insertEdit',
  'copilot_replaceString',
  'copilot_multiReplaceString',
  'copilot_createFile',
  'copilot_createDirectory',
  'copilot_createNewJupyterNotebook',
  'copilot_editNotebook',
  'copilot_runNotebookCell',
  'copilot_readFile',
  'copilot_createNewWorkspace',
  'copilot_getVSCodeAPI',
  'copilot_installExtension',
  'copilot_runVscodeCommand',
  'create_and_run_task',
  'run_in_terminal',
  'manage_todo_list',
  'copilot_memory',
  'copilot_getNotebookSummary',
  'copilot_fetchWebPage',
  'copilot_openSimpleBrowser',
  'copilot_editFiles',
  'copilot_getErrors',
  'copilot_readProjectStructure',
  'copilot_getProjectSetupInfo',
  'copilot_getDocInfo',
  'copilot_askQuestions',
  'copilot_readNotebookCellOutput',
  'copilot_switchAgent',
  'copilot_toolReplay',
  'copilot_listDirectory',
  'copilot_findFiles',
  'copilot_findTextInFiles',
  'search_subagent',
  'runSubagent',
  'vscode_get_confirmation',
  'vscode_get_terminal_confirmation',
  'inline_chat_exit',
  'copilot_githubRepo',
];
const BUILTIN_DISABLED_TOOL_SET = new Set(BUILTIN_DISABLED_TOOL_NAMES);
const DEFAULT_TOOL_GROUPING_RULES: ToolGroupingRuleConfig[] = [
  {
    id: 'angelscript',
    label: 'AngelScript',
    pattern: '^angelscript_',
  },
];
const TOOL_GROUPING_RULE_MAX_COUNT = 100;
const TOOL_GROUPING_RULE_MAX_PATTERN_LENGTH = 256;

type SchemaDefaultOverrides = Record<string, Record<string, unknown>>;

interface ToolGroupingRuleConfig {
  id: string;
  label: string;
  pattern: string;
  flags?: string;
}

interface ResolvedToolGroupingRulesResult {
  rules: CompiledToolGroupingRule[];
  warnings: string[];
}

const BUILTIN_SCHEMA_DEFAULT_OVERRIDES: string[] = [
  'lm_findTextInFiles.maxResults=500',
  'lm_findFiles.maxResults=200',
];

const LM_FIND_FILES_DESCRIPTION = [
  'Search for files in the workspace by glob pattern. This only returns the paths of matching files.',
  'Backend uses VS Code workspace file search (ripgrep-based).',
  'Use this tool when you know the exact filename pattern of the files you\'re searching for.',
  'Use \'includeIgnoredFiles\' to include files normally ignored by .gitignore, other ignore files, and `files.exclude` and `search.exclude` settings.',
  'Warning: using this may cause the search to be slower, only set it when you want to search in ignored folders like node_modules or build outputs.',
  'Glob patterns match from the root of the workspace folder. Examples:',
  '- **/*.{js,ts} to match all js/ts files in the workspace.',
  '- src/** to match all files under the top-level src folder.',
  '- **/foo/**/*.js to match all js files under any foo folder in the workspace.',
  '- In multi-root workspaces, use WorkspaceName/** (for example, UE5/**) to limit search to one workspace folder.',
].join('\n');

const LM_FIND_FILES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search for files with names or paths matching this glob pattern. Supports WorkspaceName/** to scope search to a specific workspace folder in multi-root workspaces.',
    },
    maxResults: {
      type: 'number',
      description: 'The maximum number of results to return. Do not use this unless necessary, it can slow things down. By default, only some matches are returned. If you use this and don\'t see what you\'re looking for, you can try again with a more specific query or a larger maxResults.',
    },
    includeIgnoredFiles: {
      type: 'boolean',
      description: 'Whether to include files that would normally be ignored according to .gitignore, other ignore files and `files.exclude` and `search.exclude` settings. Warning: using this may cause the search to be slower. Only set it when you want to search in ignored folders like node_modules or build outputs.',
    },
  },
  required: ['query'],
};

const LM_FIND_TEXT_IN_FILES_DESCRIPTION = [
  'Do a fast text search in the workspace. Use this tool when you want to search with an exact string or regex.',
  'Backend uses VS Code workspace text search (ripgrep-based).',
  'If you are not sure what words will appear in the workspace, prefer using regex patterns with alternation (|) or character classes to search for multiple potential words at once instead of making separate searches.',
  'For example, use \'function|method|procedure\' to look for all of those words at once.',
  'Use includePattern to search within files matching a specific pattern, or in a specific file, using a relative path.',
  'In multi-root workspaces, includePattern also supports WorkspaceName/** (for example, UE5/**) to limit search to a specific workspace folder.',
  'Glob patterns match from the root of the workspace folder. Examples:',
  '- **/*.{js,ts} to match all js/ts files in the workspace.',
  '- src/** to match all files under the top-level src folder.',
  '- **/foo/**/*.js to match all js files under any foo folder in the workspace.',
  'Use \'includeIgnoredFiles\' to include files normally ignored by .gitignore, other ignore files, and `files.exclude` and `search.exclude` settings.',
  'Warning: using this may cause the search to be slower, only set it when you want to search in ignored folders like node_modules or build outputs.',
  'When caseSensitive is false, smart-case is used by default (including regex searches). Set caseSensitive to true to force case-sensitive matching.',
  'Use this tool when you want to see an overview of a particular file, instead of using read_file many times to look for code within a file.',
].join('\n');

const LM_FIND_TEXT_IN_FILES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The pattern to search for in files in the workspace. Use regex with alternation (e.g., \'word1|word2|word3\') or character classes to find multiple potential words in a single search. Be sure to set the isRegexp property properly to declare whether it\'s a regex or plain text pattern. When caseSensitive is false, smart-case is used by default. If you need case-sensitive matching, set caseSensitive to true or use a regex pattern with an inline case-sensitivity flag.',
    },
    caseSensitive: {
      type: 'boolean',
      description: 'Whether the search should be case-sensitive. When false, smart-case is used by default (including regex). Regex inline flags can override this setting.',
    },
    isRegexp: {
      type: 'boolean',
      description: 'Whether the pattern is a regex.',
    },
    includePattern: {
      type: 'string',
      description: 'Search files matching this glob pattern. Will be applied to the relative path of files within the workspace. Supports WorkspaceName/** in multi-root workspaces to scope to a specific workspace folder. To search recursively inside a folder, use a proper glob pattern like "src/folder/**". Do not use | in includePattern.',
    },
    maxResults: {
      type: 'number',
      description: 'The maximum number of results to return. Do not use this unless necessary, it can slow things down. By default, only some matches are returned. If you use this and don\'t see what you\'re looking for, you can try again with a more specific query or a larger maxResults.',
      default: 500,
    },
    includeIgnoredFiles: {
      type: 'boolean',
      description: 'Whether to include files that would normally be ignored according to .gitignore, other ignore files and `files.exclude` and `search.exclude` settings. Warning: using this may cause the search to be slower. Only set it when you want to search in ignored folders like node_modules or build outputs.',
    },
  },
  required: ['query', 'isRegexp'],
};

const LM_GET_DIAGNOSTICS_DESCRIPTION = 'Get compile and lint diagnostics for specific files or across all files. Use this tool to inspect the same Problems diagnostics the user sees, analyze all current issues when no file is specified, and validate changes after edits. The optional filePaths parameter filters diagnostics to specific files and supports workspace-root relative paths, WorkspaceName/... paths, and absolute paths. In multi-root workspaces, relative paths must resolve to a unique existing match or use WorkspaceName/... to disambiguate.';

const LM_GET_DIAGNOSTICS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePaths: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 1,
        pattern: '\\S',
      },
      description: 'Optional file path filters. Supports workspace-root relative paths, WorkspaceName/... paths, and absolute paths. Paths must exist. In multi-root workspaces, relative paths must resolve uniquely; otherwise use WorkspaceName/... to disambiguate. Empty array means no file filter.',
    },
    severities: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
      },
      default: [...LM_GET_DIAGNOSTICS_DEFAULT_SEVERITIES],
      description: 'Optional severity filter array. Allowed values: error, warning, information, hint. If omitted, defaults to error+warning.',
    },
    maxResults: {
      type: 'integer',
      description: 'Maximum diagnostics to return across all files. Must be an integer >= 1. Defaults to 100 when omitted.',
      default: LM_GET_DIAGNOSTICS_DEFAULT_MAX_RESULTS,
      minimum: LM_GET_DIAGNOSTICS_MIN_MAX_RESULTS,
    },
  },
};

const LM_TASKS_RUN_BUILD_DESCRIPTION = [
  'Start a build task using VS Code tasks API without showing interactive pickers.',
  'If a default build task exists, it is preferred.',
  'Optional workspaceFolder can target a specific workspace folder by name or absolute path.',
].join('\n');

const LM_TASKS_RUN_TEST_DESCRIPTION = [
  'Start a test task using VS Code tasks API without showing interactive pickers.',
  'If a default test task exists, it is preferred.',
  'Optional workspaceFolder can target a specific workspace folder by name or absolute path.',
].join('\n');

const LM_TASKS_RUN_BUILD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    workspaceFolder: {
      type: 'string',
      description: 'Optional workspace folder selector. Accepts workspace name or absolute folder path.',
    },
  },
};

const LM_TASKS_RUN_TEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    workspaceFolder: {
      type: 'string',
      description: 'Optional workspace folder selector. Accepts workspace name or absolute folder path.',
    },
  },
};

const LM_DEBUG_LIST_LAUNCH_CONFIGS_DESCRIPTION = [
  'List launch configurations from workspace folders and workspace-level launch settings.',
  'Use this tool before lm_debug_start to choose a stable config index.',
  'This tool does not start debugging.',
].join('\n');

const LM_DEBUG_LIST_LAUNCH_CONFIGS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    workspaceFolder: {
      type: 'string',
      description: 'Optional workspace folder selector. Accepts workspace name or absolute folder path.',
    },
  },
};

const LM_DEBUG_START_DESCRIPTION = [
  'Start debugging without interactive pickers using launch configurations from launch.json.',
  'Selection priority: index > name > first available configuration.',
  'When name matches multiple configurations, this tool throws an ambiguity error.',
  'Optional noDebug starts without debugging.',
].join('\n');

const LM_DEBUG_START_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    index: {
      type: 'number',
      description: 'Optional 0-based index returned by lm_debug_listLaunchConfigs.',
    },
    name: {
      type: 'string',
      description: 'Optional launch configuration name. Used when index is not provided.',
    },
    workspaceFolder: {
      type: 'string',
      description: 'Optional workspace folder selector. Accepts workspace name or absolute folder path.',
    },
    noDebug: {
      type: 'boolean',
      description: 'Optional flag to start without debugging.',
      default: false,
    },
  },
};

const LM_QGREP_SEARCH_DESCRIPTION = [
  'Search indexed workspace text using qgrep regular expressions.',
  'Prefer this tool first for workspace text search: it uses qgrep as backend and is usually much faster than ripgrep on indexed workspaces.',
  'Default behavior uses smart-case: all-lowercase queries run case-insensitive, and queries containing uppercase letters run case-sensitive.',
  'qgrep indexing and search are workspace-only; external folders cannot be indexed or searched.',
  'On first use, this tool may auto-initialize qgrep indexes for all current workspace folders and block until indexing finishes.',
  'Use lm_qgrepGetStatus to inspect indexing readiness/progress when a call waits or times out.',
  'If searchPath is omitted, search runs across all initialized workspace folders.',
  'searchPath supports both paths and glob patterns in the same forms: absolute, WorkspaceName/..., or workspace-relative.',
  'Glob examples: WorkspaceName/** (for example, UE5/**), **/*.{js,ts}, src/**, **/foo/**/*.js',
].join('\n');

const LM_QGREP_GET_STATUS_DESCRIPTION = [
  'Get qgrep binary availability, workspace initialization/watch status, and indexing progress snapshot.',
  'Returns status even when qgrep is not initialized yet.',
  'When no workspace qgrep index is initialized, the returned status includes an auto-initialization hint explaining that lm_qgrepSearchText and lm_qgrepSearchFiles will auto-initialize indexes on actual query calls.',
  'Use this tool to inspect qgrep readiness before calling qgrep search tools.',
].join('\n');

const LM_QGREP_GET_STATUS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const LM_QGREP_SEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Regular expression query string for qgrep search. smart-case is applied by default (all-lowercase = case-insensitive, contains uppercase = case-sensitive).',
    },
    searchPath: {
      type: 'string',
      description: 'Optional path scope as path or glob: absolute, WorkspaceName/..., or workspace-relative. Glob examples: WorkspaceName/** (for example, UE5/**), **/*.{js,ts}, src/**, **/foo/**/*.js.',
    },
    maxResults: {
      type: 'integer',
      default: 300,
      minimum: 1,
      description: 'Maximum number of matches to return and backend qgrep search call limit. Values above 2000 are clamped to 2000; payload returns maxResultsApplied and, when clamped, maxResultsRequested.',
    },
  },
  required: ['query'],
};

const LM_QGREP_FILES_DESCRIPTION = [
  'Search indexed workspace files using qgrep file search modes.',
  'Prefer this tool first for workspace file search: it uses qgrep as backend and is usually much faster than ripgrep on indexed workspaces.',
  'Supports qgrep files modes: fp (path regex), fn (file name regex), fs (space-delimited literal components), ff (fuzzy path).',
  'qgrep indexing and file search are workspace-only; external folders cannot be indexed or searched.',
  'On first use, this tool may auto-initialize qgrep indexes for all current workspace folders and block until indexing finishes.',
  'Use lm_qgrepGetStatus to inspect indexing readiness/progress when a call waits or times out.',
  'If mode is omitted, default mode is fp.',
  'Examples:',
  '{"query":"manager","mode":"fn"}',
  '{"query":"manager\\\\.ts$","mode":"fn"}',
  '{"query":"src/r/lmanager","mode":"ff","maxResults":20}',
  '{"query":"render manager.c","mode":"fs"}',
  '{"query":"src/.*controller","mode":"fp","maxResults":50}',
  '{"query":"src/.*test","mode":"fp"}',
].join('\n');

const LM_QGREP_FILES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'File search query string. Semantics depend on mode: fp/fn use regex, fs uses space-delimited literal components, ff uses fuzzy path matching. Applied semantics are returned as querySemanticsApplied.',
    },
    mode: {
      type: 'string',
      enum: ['fp', 'fn', 'fs', 'ff'],
      default: 'fp',
      description: 'qgrep files mode. fp=path regex, fn=file name regex, fs=space-delimited literal components, ff=fuzzy path.',
    },
    maxResults: {
      type: 'integer',
      default: 300,
      minimum: 1,
      description: 'Maximum number of file results to return and backend qgrep files call limit. Values above 2000 are clamped to 2000; payload returns maxResultsApplied and, when clamped, maxResultsRequested.',
    },
  },
  required: ['query'],
};

interface LmGetDiagnosticsNormalizedDiagnostic {
  severity: LmGetDiagnosticsSeverity;
  message: string;
  source: string | null;
  code: string | null;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  tags: string[];
  preview: string;
  previewUnavailable: boolean;
  previewTruncated: boolean;
}

interface QgrepToolAggregateProgress {
  filesKnown: boolean;
  percent?: number;
  indexedFiles?: number;
  totalFiles?: number;
  remainingFiles?: number;
}

interface LmGetDiagnosticsFileResult {
  absolutePath: string;
  diagnostics: LmGetDiagnosticsNormalizedDiagnostic[];
}

interface LmGetDiagnosticsPayload {
  source: 'vscode.languages.getDiagnostics';
  scope: 'workspace+external' | 'single-file' | 'multi-file';
  severities: LmGetDiagnosticsSeverity[];
  capped: boolean;
  totalDiagnostics: number;
  files: LmGetDiagnosticsFileResult[];
}

type TaskToolKind = 'build' | 'test';

interface TaskRunPayload {
  started: boolean;
  taskName: string;
  source: string;
  scope: string;
  workspaceFolder: string | null;
  kind: TaskToolKind;
  message: string;
}

interface LaunchConfigSummary {
  index: number;
  name: string;
  type: string;
  request: string;
  scope: 'workspaceFolder' | 'workspace';
  workspaceFolder: string | null;
}

interface DebugListLaunchConfigsPayload {
  count: number;
  configs: LaunchConfigSummary[];
  message: string;
}

interface DebugStartPayload {
  started: boolean;
  noDebug: boolean;
  selectedConfig: LaunchConfigSummary;
  message: string;
}

interface LaunchConfigEntry {
  summary: LaunchConfigSummary;
  workspaceFolder: vscode.WorkspaceFolder | undefined;
  config: vscode.DebugConfiguration;
}

const schemaDefaultOverrideWarnings = new Set<string>();

export type ToolDetail = 'names' | 'full';
export type DebugLevel = 'off' | 'simple' | 'detail';

interface CustomToolInformation {
  name: string;
  description: string;
  tags: string[];
  inputSchema: unknown;
  isCustom: true;
}

interface CustomToolDefinition extends CustomToolInformation {
  invoke: (input: Record<string, unknown>) => Promise<vscode.LanguageModelToolResult>;
}

export type ExposedTool = vscode.LanguageModelToolInformation | CustomToolInformation;
function getBuiltInDisabledToolSet(): Set<string> {
  return new Set(BUILTIN_DISABLED_TOOL_SET);
}

function isBuiltInDisabledTool(name: string): boolean {
  return BUILTIN_DISABLED_TOOL_SET.has(name);
}

function getRequiredExposedToolSet(): Set<string> {
  return new Set(REQUIRED_EXPOSED_TOOL_NAMES.filter((name) => !isBuiltInDisabledTool(name)));
}

function mergeRequiredExposedTools(exposed: Set<string>): Set<string> {
  for (const name of REQUIRED_EXPOSED_TOOL_NAMES) {
    if (isBuiltInDisabledTool(name)) {
      continue;
    }
    exposed.add(name);
  }
  return exposed;
}

function getEnabledToolsSetting(): string[] {
  const enabledDelta = getConfigValue<string[]>(CONFIG_ENABLED_TOOLS, []);
  const disabledDelta = getConfigValue<string[]>(CONFIG_DISABLED_TOOLS, []);
  const enabled = new Set(filterToolNames(enabledDelta));
  const disabled = new Set(filterToolNames(disabledDelta));
  for (const name of DEFAULT_ENABLED_TOOL_NAMES) {
    if (!disabled.has(name)) {
      enabled.add(name);
    }
  }
  return [...enabled].filter((name) => !disabled.has(name));
}

function getExposedToolsSetting(): string[] {
  const disabledSet = getBuiltInDisabledToolSet();
  const exposedDelta = filterToolNames(getConfigValue<string[]>(CONFIG_EXPOSED_TOOLS, []))
    .filter((name) => !disabledSet.has(name));
  const unexposedDelta = filterToolNames(getConfigValue<string[]>(CONFIG_UNEXPOSED_TOOLS, []))
    .filter((name) => !disabledSet.has(name));
  const exposed = mergeRequiredExposedTools(new Set(exposedDelta));
  const unexposed = new Set(unexposedDelta);
  for (const requiredName of REQUIRED_EXPOSED_TOOL_NAMES) {
    unexposed.delete(requiredName);
  }
  for (const name of DEFAULT_EXPOSED_TOOL_NAMES) {
    if (!disabledSet.has(name) && !unexposed.has(name)) {
      exposed.add(name);
    }
  }
  return [...exposed].filter((name) => !unexposed.has(name) && !disabledSet.has(name));
}

function filterToolNames(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((name) => typeof name === 'string') : [];
}

function toUniqueSortedToolNames(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function areToolNameListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function parseGroupingRuleFlags(rawFlags: string): { flags: string; dropped: string[] } {
  const allowedFlags = new Set(['i', 'm', 's', 'u']);
  const dropped: string[] = [];
  let flags = '';
  for (const flag of rawFlags) {
    if (!allowedFlags.has(flag)) {
      dropped.push(flag);
      continue;
    }
    if (flags.includes(flag)) {
      continue;
    }
    flags += flag;
  }
  return { flags, dropped };
}

function getToolGroupingRulesFromConfig(): ResolvedToolGroupingRulesResult {
  const warnings: string[] = [];
  const rules: CompiledToolGroupingRule[] = [];
  const seenIds = new Set<string>();
  const rawRules = getConfigValue<unknown[]>(CONFIG_GROUPING_RULES, DEFAULT_TOOL_GROUPING_RULES as unknown[]);
  if (!Array.isArray(rawRules)) {
    warnings.push('tools.groupingRules ignored: expected array.');
    return { rules, warnings };
  }

  for (let index = 0; index < rawRules.length; index += 1) {
    if (rules.length >= TOOL_GROUPING_RULE_MAX_COUNT) {
      warnings.push(`tools.groupingRules ignored: rule count exceeds ${TOOL_GROUPING_RULE_MAX_COUNT}.`);
      break;
    }
    const rawRule = rawRules[index];
    if (!isPlainObject(rawRule)) {
      warnings.push(`tools.groupingRules[${index}] ignored: expected object.`);
      continue;
    }
    const id = typeof rawRule.id === 'string' ? rawRule.id.trim() : '';
    const label = typeof rawRule.label === 'string' ? rawRule.label.trim() : '';
    const pattern = typeof rawRule.pattern === 'string' ? rawRule.pattern.trim() : '';
    const rawFlags = typeof rawRule.flags === 'string' ? rawRule.flags.trim() : '';

    if (id.length === 0 || label.length === 0 || pattern.length === 0) {
      warnings.push(`tools.groupingRules[${index}] ignored: id/label/pattern are required.`);
      continue;
    }
    if (pattern.length > TOOL_GROUPING_RULE_MAX_PATTERN_LENGTH) {
      warnings.push(`tools.groupingRules[${index}] ignored: pattern length exceeds ${TOOL_GROUPING_RULE_MAX_PATTERN_LENGTH}.`);
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push(`tools.groupingRules[${index}] ignored: duplicate id "${id}".`);
      continue;
    }

    const { flags, dropped } = parseGroupingRuleFlags(rawFlags);
    if (dropped.length > 0) {
      warnings.push(`tools.groupingRules[${index}] dropped flags "${dropped.join('')}".`);
    }

    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern, flags);
    } catch (error) {
      warnings.push(`tools.groupingRules[${index}] ignored: invalid regex (${String(error)}).`);
      continue;
    }

    seenIds.add(id);
    rules.push({
      id,
      label,
      groupId: `custom_rule:${id}`,
      disabledGroupId: `builtin_disabled_custom_rule:${id}`,
      matcher,
    });
  }
  return { rules, warnings };
}

function logResolvedToolGroupingRules(result: ResolvedToolGroupingRulesResult): void {
  if (getDebugLevel() !== 'detail') {
    return;
  }
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      toolingLogger.warn(warning);
    }
  }
  const summary = result.rules
    .map((rule) => `${rule.id}:${rule.matcher.source}`)
    .join(', ');
  toolingLogger.info(`tools.groupingRules resolved ${result.rules.length} rule(s)${summary.length > 0 ? ` => ${summary}` : ''}.`);
}

async function pruneRequiredExposureDeltas(): Promise<void> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);
  const requiredSet = getRequiredExposedToolSet();
  const currentUnexposedDelta = filterToolNames(getConfigValue<string[]>(CONFIG_UNEXPOSED_TOOLS, []));
  const nextUnexposedDelta = currentUnexposedDelta.filter((name) => !requiredSet.has(name));
  if (!areToolNameListsEqual(currentUnexposedDelta, nextUnexposedDelta)) {
    await config.update(CONFIG_UNEXPOSED_TOOLS, toUniqueSortedToolNames(nextUnexposedDelta), target);
  }
}

export async function pruneBuiltInDisabledFromDeltas(): Promise<void> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);
  const disabledSet = getBuiltInDisabledToolSet();
  const currentExposedDelta = filterToolNames(getConfigValue<string[]>(CONFIG_EXPOSED_TOOLS, []));
  const currentUnexposedDelta = filterToolNames(getConfigValue<string[]>(CONFIG_UNEXPOSED_TOOLS, []));
  const currentEnabledDelta = filterToolNames(getConfigValue<string[]>(CONFIG_ENABLED_TOOLS, []));
  const currentDisabledDelta = filterToolNames(getConfigValue<string[]>(CONFIG_DISABLED_TOOLS, []));
  const nextExposedDelta = currentExposedDelta.filter((name) => !disabledSet.has(name));
  const nextUnexposedDelta = currentUnexposedDelta.filter((name) => !disabledSet.has(name));
  const nextEnabledDelta = currentEnabledDelta.filter((name) => !disabledSet.has(name));
  const nextDisabledDelta = currentDisabledDelta.filter((name) => !disabledSet.has(name));
  const removed = new Set<string>([
    ...currentExposedDelta.filter((name) => disabledSet.has(name)),
    ...currentUnexposedDelta.filter((name) => disabledSet.has(name)),
    ...currentEnabledDelta.filter((name) => disabledSet.has(name)),
    ...currentDisabledDelta.filter((name) => disabledSet.has(name)),
  ]);

  if (!areToolNameListsEqual(currentExposedDelta, nextExposedDelta)) {
    await config.update(CONFIG_EXPOSED_TOOLS, toUniqueSortedToolNames(nextExposedDelta), target);
  }
  if (!areToolNameListsEqual(currentUnexposedDelta, nextUnexposedDelta)) {
    await config.update(CONFIG_UNEXPOSED_TOOLS, toUniqueSortedToolNames(nextUnexposedDelta), target);
  }
  if (!areToolNameListsEqual(currentEnabledDelta, nextEnabledDelta)) {
    await config.update(CONFIG_ENABLED_TOOLS, toUniqueSortedToolNames(nextEnabledDelta), target);
  }
  if (!areToolNameListsEqual(currentDisabledDelta, nextDisabledDelta)) {
    await config.update(CONFIG_DISABLED_TOOLS, toUniqueSortedToolNames(nextDisabledDelta), target);
  }
  if (removed.size > 0 && getDebugLevel() === 'detail') {
    toolingLogger.info(`pruneBuiltInDisabledFromDeltas removed: ${[...removed].sort((a, b) => a.localeCompare(b)).join(', ')}`);
  }
}

export async function pruneEnabledDeltasByExposed(exposed: ReadonlySet<string>): Promise<void> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);

  const currentEnabledDelta = filterToolNames(getConfigValue<string[]>(CONFIG_ENABLED_TOOLS, []));
  const currentDisabledDelta = filterToolNames(getConfigValue<string[]>(CONFIG_DISABLED_TOOLS, []));
  const nextEnabledDelta = currentEnabledDelta.filter((name) => exposed.has(name));
  const nextDisabledDelta = currentDisabledDelta.filter((name) => exposed.has(name));

  if (!areToolNameListsEqual(currentEnabledDelta, nextEnabledDelta)) {
    await config.update(CONFIG_ENABLED_TOOLS, nextEnabledDelta, target);
  }
  if (!areToolNameListsEqual(currentDisabledDelta, nextDisabledDelta)) {
    await config.update(CONFIG_DISABLED_TOOLS, nextDisabledDelta, target);
  }
}

export async function normalizeToolSelectionState(): Promise<void> {
  await pruneBuiltInDisabledFromDeltas();
  await pruneRequiredExposureDeltas();
  const exposedSet = new Set(getExposedToolsSetting());
  await pruneEnabledDeltasByExposed(exposedSet);
}

async function setExposedTools(exposed: string[]): Promise<void> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);
  const disabledSet = getBuiltInDisabledToolSet();
  const exposedSet = mergeRequiredExposedTools(new Set(exposed.filter((name) => !disabledSet.has(name))));
  const defaultSet = new Set(DEFAULT_EXPOSED_TOOL_NAMES.filter((name) => !disabledSet.has(name)));
  const exposedDelta = [...exposedSet].filter((name) => !defaultSet.has(name));
  const requiredSet = getRequiredExposedToolSet();
  const unexposedDelta = DEFAULT_EXPOSED_TOOL_NAMES
    .filter((name) => !disabledSet.has(name))
    .filter((name) => !exposedSet.has(name))
    .filter((name) => !requiredSet.has(name));
  await config.update(CONFIG_EXPOSED_TOOLS, toUniqueSortedToolNames(exposedDelta), target);
  await config.update(CONFIG_UNEXPOSED_TOOLS, toUniqueSortedToolNames(unexposedDelta), target);
  await pruneEnabledDeltasByExposed(exposedSet);
}

async function setEnabledTools(enabled: string[]): Promise<void> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);
  const disabledSet = getBuiltInDisabledToolSet();
  const exposedSet = new Set(getExposedToolsSetting().filter((name) => !disabledSet.has(name)));
  const enabledSet = new Set(enabled.filter((name) => exposedSet.has(name) && !disabledSet.has(name)));
  const defaultSet = new Set(DEFAULT_ENABLED_TOOL_NAMES.filter((name) => exposedSet.has(name)));
  const enabledDelta = [...enabledSet].filter((name) => !defaultSet.has(name));
  const disabledDelta = [...defaultSet].filter((name) => !enabledSet.has(name));
  await config.update(CONFIG_ENABLED_TOOLS, toUniqueSortedToolNames(enabledDelta), target);
  await config.update(CONFIG_DISABLED_TOOLS, toUniqueSortedToolNames(disabledDelta), target);
}

async function resetExposedTools(): Promise<void> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);
  await config.update(CONFIG_EXPOSED_TOOLS, [], target);
  await config.update(CONFIG_UNEXPOSED_TOOLS, [], target);
  await normalizeToolSelectionState();
}

async function resetEnabledTools(): Promise<void> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);
  await config.update(CONFIG_ENABLED_TOOLS, [], target);
  await config.update(CONFIG_DISABLED_TOOLS, [], target);
}

function formatTags(tags: readonly string[]): string {
  return tags.length > 0 ? tags.join(', ') : '(none)';
}

function formatSchema(schema: unknown): string {
  if (!schema) {
    return '(none)';
  }

  return JSON.stringify(schema, null, 2);
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split(/\r?\n/u)
    .map((line) => `${pad}${line}`)
    .join('\n');
}

function dumpLmTools(channel: vscode.OutputChannel): void {
  const tools = getEnabledExposedToolsSnapshot();
  if (tools.length === 0) {
    channel.appendLine('No tools found in vscode.lm.tools.');
    return;
  }

  channel.appendLine(`Found ${tools.length} tool(s):`);
  channel.appendLine('');

  for (let i = 0; i < tools.length; i += 1) {
    const tool = tools[i];
    channel.appendLine(`Tool ${i + 1}:`);
    channel.appendLine(`  name: ${tool.name}`);
    channel.appendLine(`  description: ${tool.description}`);
    channel.appendLine(`  tags: ${formatTags(tool.tags)}`);
    channel.appendLine('  inputSchema:');
    channel.appendLine(indentLines(formatSchema(tool.inputSchema), 4));

    if (i < tools.length - 1) {
      channel.appendLine('');
    }
  }
}

export function showEnabledToolsDump(channel: vscode.OutputChannel): void {
  channel.clear();
  channel.show(true);
  dumpLmTools(channel);
}

interface ToolPickerEntry {
  name: string;
  description: string;
  tags: readonly string[];
  picked: boolean;
  readOnly?: boolean;
}

async function pickToolsWithQuickPick(options: {
  title: string;
  placeHolder: string;
  resetLabel: string;
  resetDescription: string;
  entries: readonly ToolPickerEntry[];
}): Promise<ToolConfigPanelResult> {
  const items: Array<vscode.QuickPickItem & { toolName?: string; isReset?: boolean }> = [];
  items.push({
    label: options.resetLabel,
    description: options.resetDescription,
    alwaysShow: true,
    isReset: true,
  });
  items.push({ label: 'Tools', kind: vscode.QuickPickItemKind.Separator });

  for (const entry of options.entries) {
    items.push({
      label: entry.name,
      description: entry.description,
      detail: entry.tags.length > 0 ? entry.tags.join(', ') : undefined,
      picked: entry.picked,
      toolName: entry.name,
    });
  }

  const selections = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: options.title,
    placeHolder: options.placeHolder,
  });
  if (!selections) {
    return { action: 'cancel' };
  }
  if (selections.some((item) => item.isReset)) {
    return { action: 'reset' };
  }
  const selected = selections
    .map((item) => item.toolName)
    .filter((name): name is string => typeof name === 'string');
  return { action: 'apply', selected };
}

export async function configureExposureTools(): Promise<void> {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    void vscode.window.showWarningMessage('vscode.lm is not available in this VS Code version.');
    return;
  }

  const allTools = getAllToolsSnapshot();
  if (allTools.length === 0) {
    void vscode.window.showInformationMessage('No tools found for MCP exposure.');
    return;
  }
  const tools = getAllToolsSnapshot();
  const groupingRulesResult = getToolGroupingRulesFromConfig();
  logResolvedToolGroupingRules(groupingRulesResult);
  const builtInDisabledSet = getBuiltInDisabledToolSet();
  const exposedSet = new Set(getExposedToolsSetting());
  const requiredExposedSet = getRequiredExposedToolSet();
  const entries: ToolPickerEntry[] = tools.map((tool) => ({
    name: tool.name,
    description: builtInDisabledSet.has(tool.name)
      ? `${tool.description ?? ''} (Built-in disabled tool; exposure is blocked)`
      : requiredExposedSet.has(tool.name)
      ? `${tool.description ?? ''} (Always exposed by default policy)`
      : (tool.description ?? ''),
    tags: tool.tags,
    picked: builtInDisabledSet.has(tool.name) ? false : exposedSet.has(tool.name),
    readOnly: builtInDisabledSet.has(tool.name) || requiredExposedSet.has(tool.name),
  }));
  const sections = buildGroupedToolSections(
    tools.map((tool) => ({
      name: tool.name,
      description: builtInDisabledSet.has(tool.name)
        ? `${tool.description ?? ''} (Built-in disabled tool; exposure is blocked)`
        : requiredExposedSet.has(tool.name)
          ? `${tool.description ?? ''} (Always exposed by default policy)`
          : (tool.description ?? ''),
      tags: tool.tags,
      picked: builtInDisabledSet.has(tool.name) ? false : exposedSet.has(tool.name),
      readOnly: builtInDisabledSet.has(tool.name) || requiredExposedSet.has(tool.name),
      builtInDisabled: builtInDisabledSet.has(tool.name),
      isCustom: isCustomTool(tool),
    })),
    { customRules: groupingRulesResult.rules },
  );
  if (sections.length === 0) {
    toolingLogger.warn('Exposure tool panel sections are empty, fallback to QuickPick.');
    const fallbackSelection = await pickToolsWithQuickPick({
      title: 'Configure exposure for LM tools',
      placeHolder: 'Select tools available for MCP exposure.',
      resetLabel: '$(refresh) Reset (default exposed tools)',
      resetDescription: 'Restore default exposed tools',
      entries,
    });
    if (fallbackSelection.action === 'cancel') {
      return;
    }
    if (fallbackSelection.action === 'reset') {
      await resetExposedTools();
      void vscode.window.showInformationMessage('Restored default exposed tools.');
      return;
    }
    const fallbackNames = fallbackSelection.selected.filter((name) => !builtInDisabledSet.has(name));
    const fallbackEnforcedNames = mergeRequiredExposedTools(new Set(fallbackNames));
    await setExposedTools([...fallbackEnforcedNames]);
    void vscode.window.showInformationMessage(`Configured exposure for ${fallbackEnforcedNames.size} tool(s).`);
    return;
  }

  let selection: ToolConfigPanelResult;
  try {
    selection = await showToolConfigPanel({
      mode: 'exposure',
      title: 'Configure exposure for LM tools',
      placeHolder: 'Search tools by name, description, or tags.',
      resetLabel: 'Reset',
      resetDescription: 'Restore default exposed tools',
      sections,
    });
  } catch (error) {
    toolingLogger.warn(`Tool config panel failed, fallback to QuickPick: ${String(error)}`);
    selection = await pickToolsWithQuickPick({
      title: 'Configure exposure for LM tools',
      placeHolder: 'Select tools available for MCP exposure.',
      resetLabel: '$(refresh) Reset (default exposed tools)',
      resetDescription: 'Restore default exposed tools',
      entries,
    });
  }

  if (selection.action === 'cancel') {
    return;
  }
  if (selection.action === 'reset') {
    await resetExposedTools();
    void vscode.window.showInformationMessage('Restored default exposed tools.');
    return;
  }

  const names = selection.selected;
  const filteredNames = names.filter((name) => !builtInDisabledSet.has(name));
  const enforcedNames = mergeRequiredExposedTools(new Set(filteredNames));
  await setExposedTools([...enforcedNames]);
  void vscode.window.showInformationMessage(`Configured exposure for ${enforcedNames.size} tool(s).`);
}

export async function configureEnabledTools(): Promise<void> {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    void vscode.window.showWarningMessage('vscode.lm is not available in this VS Code version.');
    return;
  }

  const tools = getExposedToolsSnapshot();
  if (tools.length === 0) {
    void vscode.window.showWarningMessage('No exposed tools available to enable.');
    return;
  }
  const groupingRulesResult = getToolGroupingRulesFromConfig();
  logResolvedToolGroupingRules(groupingRulesResult);

  const enabledSet = new Set(getEnabledToolsSetting());
  const entries: ToolPickerEntry[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    tags: tool.tags,
    picked: enabledSet.has(tool.name),
  }));
  const sections = buildGroupedToolSections(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      tags: tool.tags,
      picked: enabledSet.has(tool.name),
      isCustom: isCustomTool(tool),
    })),
    { customRules: groupingRulesResult.rules },
  );
  if (sections.length === 0) {
    toolingLogger.warn('Enabled tool panel sections are empty, fallback to QuickPick.');
    const fallbackSelection = await pickToolsWithQuickPick({
      title: 'Configure enabled LM tools',
      placeHolder: 'Select exposed tools to enable.',
      resetLabel: '$(refresh) Reset (default enabled tools)',
      resetDescription: 'Restore default enabled tools',
      entries,
    });
    if (fallbackSelection.action === 'cancel') {
      return;
    }
    if (fallbackSelection.action === 'reset') {
      await resetEnabledTools();
      await pruneEnabledDeltasByExposed(new Set(getExposedToolsSetting()));
      void vscode.window.showInformationMessage('Restored default enabled tools.');
      return;
    }
    await setEnabledTools(fallbackSelection.selected);
    void vscode.window.showInformationMessage(`Enabled ${fallbackSelection.selected.length} tool(s).`);
    return;
  }

  let selection: ToolConfigPanelResult;
  try {
    selection = await showToolConfigPanel({
      mode: 'enabled',
      title: 'Configure enabled LM tools',
      placeHolder: 'Search tools by name, description, or tags.',
      resetLabel: 'Reset',
      resetDescription: 'Restore default enabled tools',
      sections,
    });
  } catch (error) {
    toolingLogger.warn(`Enabled config panel failed, fallback to QuickPick: ${String(error)}`);
    selection = await pickToolsWithQuickPick({
      title: 'Configure enabled LM tools',
      placeHolder: 'Select exposed tools to enable.',
      resetLabel: '$(refresh) Reset (default enabled tools)',
      resetDescription: 'Restore default enabled tools',
      entries,
    });
  }

  if (selection.action === 'cancel') {
    return;
  }
  if (selection.action === 'reset') {
    await resetEnabledTools();
    await pruneEnabledDeltasByExposed(new Set(getExposedToolsSetting()));
    void vscode.window.showInformationMessage('Restored default enabled tools.');
    return;
  }

  const names = selection.selected;
  await setEnabledTools(names);
  void vscode.window.showInformationMessage(`Enabled ${names.length} tool(s).`);
}
function extractSchemaPropertyNames(schema: unknown): Set<string> | undefined {
  const names = new Set<string>();
  collectSchemaPropertyNames(schema, names);
  return names.size > 0 ? names : undefined;
}

function collectSchemaPropertyNames(schema: unknown, out: Set<string>): void {
  if (!schema || typeof schema !== 'object') {
    return;
  }
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      collectSchemaPropertyNames(entry, out);
    }
    return;
  }
  const record = schema as Record<string, unknown>;
  const props = record.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const key of Object.keys(props as Record<string, unknown>)) {
      out.add(key);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectSchemaPropertyNames(entry, out);
      }
    }
  }
}

function extractSchemaRequiredNames(schema: unknown): Set<string> | undefined {
  const requiredNames = new Set<string>();
  collectSchemaRequiredNames(schema, requiredNames);
  return requiredNames.size > 0 ? requiredNames : undefined;
}

function collectSchemaRequiredNames(schema: unknown, out: Set<string>): void {
  if (!schema || typeof schema !== 'object') {
    return;
  }
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      collectSchemaRequiredNames(entry, out);
    }
    return;
  }
  const record = schema as Record<string, unknown>;
  const required = extractRequired(record);
  if (required) {
    for (const name of required) {
      out.add(name);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectSchemaRequiredNames(entry, out);
      }
    }
  }
}

function applySchemaDefaults(schema: unknown, toolName: string): unknown {
  const overrides = getSchemaDefaultOverridesForTool(toolName, schema);
  return applySchemaDefaultsInternal(schema, overrides, undefined);
}

function applyInputDefaultsToToolInput(
  input: Record<string, unknown>,
  schema: unknown,
  toolName: string,
): Record<string, unknown> {
  const overrides = getSchemaDefaultOverridesForTool(toolName, schema);
  const allowed = extractSchemaPropertyNames(schema);
  const required = extractSchemaRequiredNames(schema);
  const result: Record<string, unknown> = { ...input };
  for (const [name, value] of Object.entries(overrides)) {
    if (name in result && result[name] !== undefined) {
      continue;
    }
    if (!allowed || !allowed.has(name)) {
      continue;
    }
    if (required && required.has(name)) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function applySchemaDefaultsInternal(
  schema: unknown,
  overrides: Record<string, unknown>,
  requiredNames: Set<string> | undefined,
): unknown {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => applySchemaDefaultsInternal(item, overrides, undefined));
  }

  const record = schema as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  const currentRequired = extractRequired(record) ?? requiredNames;

  for (const [key, value] of Object.entries(record)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props = value as Record<string, unknown>;
      const newProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(props)) {
        if (propSchema && typeof propSchema === 'object') {
          const propCopy = { ...(propSchema as Record<string, unknown>) };
          const defaultValue = resolveSchemaDefault(propName, overrides);
          const isRequired = currentRequired?.has(propName) ?? false;
          if (defaultValue !== undefined && !isRequired && !('default' in propCopy)) {
            propCopy.default = defaultValue;
          }
          newProps[propName] = applySchemaDefaultsInternal(propCopy, overrides, extractRequired(propCopy));
        } else {
          newProps[propName] = applySchemaDefaultsInternal(propSchema, overrides, undefined);
        }
      }
      copy[key] = newProps;
      continue;
    }

    if (key === 'items') {
      copy[key] = applySchemaDefaultsInternal(value, overrides, undefined);
      continue;
    }

    if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) {
      copy[key] = value.map((entry) => applySchemaDefaultsInternal(entry, overrides, undefined));
      continue;
    }

    copy[key] = applySchemaDefaultsInternal(value, overrides, undefined);
  }

  return copy;
}

function extractRequired(schemaRecord: Record<string, unknown>): Set<string> | undefined {
  const required = schemaRecord.required;
  if (Array.isArray(required) && required.every((item) => typeof item === 'string')) {
    return new Set(required as string[]);
  }
  return undefined;
}

function getSchemaDefaultOverrides(): SchemaDefaultOverrides {
  const fromConfig = getConfigValue<unknown>('tools.schemaDefaults', []);
  const overrides = parseSchemaDefaultOverrides(fromConfig);
  const merged: SchemaDefaultOverrides = {};
  const builtinOverrides = parseSchemaDefaultOverrides(BUILTIN_SCHEMA_DEFAULT_OVERRIDES);
  for (const [toolName, toolDefaults] of Object.entries(builtinOverrides)) {
    merged[toolName] = { ...toolDefaults };
  }
  for (const [toolName, toolDefaults] of Object.entries(overrides)) {
    merged[toolName] = { ...(merged[toolName] ?? {}), ...toolDefaults };
  }
  return merged;
}

function getSchemaDefaultOverridesForTool(toolName: string, schema: unknown): Record<string, unknown> {
  if (!toolName) {
    return {};
  }
  const overrides = getSchemaDefaultOverrides();
  const toolOverrides = overrides[toolName];
  if (!toolOverrides) {
    return {};
  }
  const allowedNames = extractSchemaPropertyNames(schema);
  if (!allowedNames || allowedNames.size === 0) {
    return { ...toolOverrides };
  }
  const filtered: Record<string, unknown> = {};
  for (const [paramName, paramValue] of Object.entries(toolOverrides)) {
    if (!allowedNames.has(paramName)) {
      warnSchemaDefaultOverride(toolName, paramName, 'parameter is not defined in the tool schema', paramValue);
      continue;
    }
    const propertySchema = findSchemaPropertySchema(schema, paramName);
    const validation = propertySchema ? schemaAllowsValue(propertySchema, paramValue) : undefined;
    if (validation === false) {
      warnSchemaDefaultOverride(toolName, paramName, 'parameter value type does not match the tool schema', paramValue, propertySchema);
      continue;
    }
    filtered[paramName] = paramValue;
  }
  return filtered;
}

function parseSchemaDefaultOverrides(value: unknown): SchemaDefaultOverrides {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      warnSchemaDefaultOverrideEntry(String(value), 'expected an array of strings');
    }
    return {};
  }
  const result: SchemaDefaultOverrides = {};
  for (const entry of value) {
    if (typeof entry !== 'string') {
      warnSchemaDefaultOverrideEntry(String(entry), 'entry is not a string');
      continue;
    }
    const parsed = parseSchemaDefaultOverrideEntry(entry);
    if (!parsed) {
      continue;
    }
    const toolDefaults = result[parsed.toolName] ?? {};
    toolDefaults[parsed.paramName] = parsed.paramValue;
    result[parsed.toolName] = toolDefaults;
  }
  return result;
}

function parseSchemaDefaultOverrideEntry(
  entry: string,
): { toolName: string; paramName: string; paramValue: unknown } | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    warnSchemaDefaultOverrideEntry(entry, 'entry is empty');
    return undefined;
  }
  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex <= 0 || equalsIndex === trimmed.length - 1) {
    warnSchemaDefaultOverrideEntry(entry, 'expected "tool.param=value" format');
    return undefined;
  }
  const key = trimmed.slice(0, equalsIndex).trim();
  const rawValue = trimmed.slice(equalsIndex + 1).trim();
  if (!key || rawValue.length === 0) {
    warnSchemaDefaultOverrideEntry(entry, 'expected "tool.param=value" format');
    return undefined;
  }
  const parts = key.split('.');
  if (parts.length !== 2) {
    warnSchemaDefaultOverrideEntry(entry, 'expected "tool.param=value" format');
    return undefined;
  }
  const toolName = parts[0]?.trim();
  const paramName = parts[1]?.trim();
  if (!toolName || !paramName) {
    warnSchemaDefaultOverrideEntry(entry, 'expected "tool.param=value" format');
    return undefined;
  }
  const parsedValue = parseSchemaDefaultOverrideValue(rawValue);
  if (parsedValue === undefined) {
    warnSchemaDefaultOverrideEntry(entry, 'value must be a quoted string, number, boolean, or array');
    return undefined;
  }
  return { toolName, paramName, paramValue: parsedValue };
}

function parseSchemaDefaultOverrideValue(rawValue: string): unknown | undefined {
  if (rawValue.startsWith('{')) {
    if (!rawValue.endsWith('}')) {
      return undefined;
    }
    return parseSchemaDefaultOverrideArray(rawValue.slice(1, -1));
  }
  if (rawValue.startsWith('[')) {
    return undefined;
  }
  return parseSchemaDefaultOverrideScalar(rawValue);
}

function parseSchemaDefaultOverrideArray(rawValue: string): unknown[] | undefined {
  if (rawValue.length === 0) {
    return [];
  }
  const entries = rawValue.split(',');
  const result: unknown[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      result.push('');
      continue;
    }
    const parsed = parseSchemaDefaultOverrideArrayItem(trimmed);
    if (parsed === undefined) {
      return undefined;
    }
    result.push(parsed);
  }
  return result;
}

function parseSchemaDefaultOverrideArrayItem(rawValue: string): unknown | undefined {
  if (rawValue.startsWith('"') || rawValue.endsWith('"')) {
    if (!(rawValue.startsWith('"') && rawValue.endsWith('"'))) {
      return undefined;
    }
    return rawValue.slice(1, -1);
  }
  return parseSchemaDefaultOverrideScalar(rawValue);
}

function parseSchemaDefaultOverrideScalar(rawValue: string): unknown | undefined {
  const normalized = rawValue.toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  const numberValue = parseSchemaDefaultOverrideNumber(rawValue);
  if (numberValue !== undefined) {
    return numberValue;
  }
  if (rawValue.startsWith('"') || rawValue.endsWith('"')) {
    if (!(rawValue.startsWith('"') && rawValue.endsWith('"'))) {
      return undefined;
    }
    return rawValue.slice(1, -1);
  }
  return undefined;
}

function parseSchemaDefaultOverrideNumber(rawValue: string): number | undefined {
  if (!/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/u.test(rawValue)) {
    return undefined;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function warnSchemaDefaultOverride(
  toolName: string,
  paramName: string,
  reason: string,
  value: unknown,
  propertySchema?: Record<string, unknown>,
): void {
  const key = `${toolName}.${paramName}:${reason}`;
  if (schemaDefaultOverrideWarnings.has(key)) {
    return;
  }
  schemaDefaultOverrideWarnings.add(key);
  const valueText = formatSchemaDefaultValue(value);
  const expectedText = propertySchema ? describeSchemaPropertyExpected(propertySchema) : undefined;
  const details = expectedText ? `; expected ${expectedText}` : '';
  toolingLogger.warn(`lmToolsBridge.tools.schemaDefaults ignored: ${toolName}.${paramName}=${valueText} (${reason}${details}).`);
}

function warnSchemaDefaultOverrideEntry(entry: string, reason: string): void {
  const key = `entry:${entry}:${reason}`;
  if (schemaDefaultOverrideWarnings.has(key)) {
    return;
  }
  schemaDefaultOverrideWarnings.add(key);
  toolingLogger.warn(`lmToolsBridge.tools.schemaDefaults ignored: "${entry}" (${reason}).`);
}

function formatSchemaDefaultValue(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

function describeSchemaPropertyExpected(schema: Record<string, unknown>): string | undefined {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return `enum ${JSON.stringify(enumValues)}`;
  }
  const typeValue = schema.type;
  if (typeof typeValue === 'string') {
    return typeValue;
  }
  if (Array.isArray(typeValue)) {
    return typeValue.filter((entry) => typeof entry === 'string').join('|') || undefined;
  }
  return undefined;
}

function findSchemaPropertySchema(schema: unknown, name: string): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      const found = findSchemaPropertySchema(entry, name);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  const props = record.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const propRecord = props as Record<string, unknown>;
    const propSchema = propRecord[name];
    if (propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)) {
      return propSchema as Record<string, unknown>;
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findSchemaPropertySchema(entry, name);
        if (found) {
          return found;
        }
      }
    }
  }
  return undefined;
}

function schemaAllowsValue(schema: Record<string, unknown>, value: unknown): boolean | undefined {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues) {
    return enumValues.some((entry) => enumValueMatches(entry, value));
  }
  const typeValue = schema.type;
  const types = Array.isArray(typeValue)
    ? typeValue.filter((entry) => typeof entry === 'string')
    : typeof typeValue === 'string'
      ? [typeValue]
      : [];
  if (types.length === 0) {
    return undefined;
  }
  return types.some((entry) => schemaAllowsValueForType(entry, schema, value));
}

function enumValueMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return false;
    }
    for (let index = 0; index < expected.length; index += 1) {
      if (!Object.is(expected[index], actual[index])) {
        return false;
      }
    }
    return true;
  }
  return Object.is(expected, actual);
}

function schemaAllowsValueForType(typeValue: string, schema: Record<string, unknown>, value: unknown): boolean {
  switch (typeValue) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'array':
      return schemaAllowsArrayValue(schema, value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function schemaAllowsArrayValue(schema: Record<string, unknown>, value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const items = schema.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    return true;
  }
  return value.every((entry) => schemaAllowsValue(items as Record<string, unknown>, entry) !== false);
}

export function getDebugLevel(): DebugLevel {
  const rawValue = normalizeConfigString(getConfigValue<string>(CONFIG_DEBUG, 'off'));
  const value = rawValue ? rawValue.toLowerCase() : '';
  if (value === 'detail' || value === 'simple') {
    return value;
  }
  return 'off';
}

function resolveSchemaDefault(name: string, overrides: Record<string, unknown>): unknown {
  if (name in overrides) {
    return overrides[name];
  }
  return undefined;
}

function normalizeConfigString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
function formatToolInfoText(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (name) {
    lines.push(`name: ${name}`);
  }
  const description = typeof payload.description === 'string' ? payload.description : '';
  if (description) {
    lines.push(`description: ${description}`);
  }
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  if (tags.length > 0) {
    lines.push('tags:');
    for (const tag of tags) {
      lines.push(`  - ${tag}`);
    }
  }
  if (payload.inputSchema !== undefined) {
    lines.push('inputSchema:');
    lines.push(indentLines(formatSchema(payload.inputSchema as object | undefined), 2));
  }
  const toolUri = typeof payload.toolUri === 'string' ? payload.toolUri : '';
  if (toolUri) {
    lines.push(`toolUri: ${toolUri}`);
  }
  const schemaUri = typeof payload.schemaUri === 'string' ? payload.schemaUri : '';
  if (schemaUri) {
    lines.push(`schemaUri: ${schemaUri}`);
  }
  if (payload.usageHint !== undefined) {
    lines.push('usageHint:');
    lines.push(indentLines(safePrettyStringify(payload.usageHint), 2));
  }
  return lines.join('\n');
}

function formatToolErrorText(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const error = typeof payload.error === 'string' ? payload.error : 'Unknown error';
  lines.push(`error: ${error}`);
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (name) {
    lines.push(`name: ${name}`);
  }
  const requiresToken = payload.requiresToolInvocationToken === true;
  if (requiresToken) {
    lines.push('requiresToolInvocationToken: true');
  }
  const hint = typeof payload.hint === 'string' ? payload.hint : '';
  if (hint) {
    lines.push(`hint: ${hint}`);
  }
  if (payload.inputSchema !== undefined) {
    lines.push('inputSchema:');
    lines.push(indentLines(formatSchema(payload.inputSchema as object | undefined), 2));
  }
  return lines.join('\n');
}

export function listToolsPayload(tools: readonly ExposedTool[], detail: ToolDetail) {
  const orderedTools = prioritizeTool(tools, 'getVSCodeWorkspace');
  if (detail === 'names') {
    return { tools: orderedTools.map((tool) => tool.name) };
  }

  return {
    tools: orderedTools.map((tool) => toolInfoPayload(tool, 'full')),
  };
}

export function toolInfoPayload(tool: ExposedTool, detail: ToolDetail) {
  if (detail === 'names') {
    return {
      name: tool.name,
    };
  }
  const inputSchema = buildToolInputSchema(tool);

  return {
    name: tool.name,
    description: tool.description,
    tags: tool.tags,
    inputSchema,
    toolUri: getToolUri(tool.name),
    schemaUri: getSchemaUri(tool.name),
    usageHint: getToolUsageHint(tool),
  };
}

export function buildToolInputSchema(tool: ExposedTool): unknown {
  return applySchemaDefaults(tool.inputSchema ?? null, tool.name);
}

function serializeToolResult(result: vscode.LanguageModelToolResult): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push({
        type: 'text',
        text: part.value,
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelPromptTsxPart) {
      parts.push({
        type: 'prompt-tsx',
        value: part.value,
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      const payload: Record<string, unknown> = {
        type: 'data',
        mimeType: part.mimeType,
        byteLength: part.data.byteLength,
      };

      const decodedText = decodeTextData(part);
      if (decodedText !== undefined) {
        payload.text = decodedText;
      }

      parts.push(payload);
      continue;
    }

    const serialized = safeStringify(part);
    parts.push({
      type: 'unknown',
      text: serialized,
    });
  }

  return parts;
}

function serializedToolResultToText(parts: readonly Record<string, unknown>[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    const text = serializedToolResultPartToText(part);
    if (text.length > 0) {
      segments.push(text);
    }
  }
  return joinPromptTsxTextParts(segments);
}

function extractTextPayloadFromTextParts(parts: readonly Record<string, unknown>[]): { hasTextPart: boolean; text: string } {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }
  return {
    hasTextPart: textParts.length > 0,
    text: joinPromptTsxTextParts(textParts),
  };
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMimeType(mimeType: string): string {
  const separatorIndex = mimeType.indexOf(';');
  const rawType = separatorIndex === -1 ? mimeType : mimeType.slice(0, separatorIndex);
  return rawType.trim().toLowerCase();
}

function isJsonMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== 'string') {
    return false;
  }
  const normalized = normalizeMimeType(mimeType);
  if (normalized.endsWith('+json')) {
    return true;
  }
  return normalized === 'application/json'
    || normalized === 'application/x-json'
    || normalized === 'text/json'
    || normalized === 'text/x-json';
}

function extractStructuredContentFromDataParts(
  parts: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (const part of parts) {
    if (part.type !== 'data' || !isJsonMimeType(part.mimeType) || typeof part.text !== 'string') {
      continue;
    }
    const parsed = tryParseJsonObject(part.text);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function resolveStructuredToolResultPayload(
  result: vscode.LanguageModelToolResult,
  serialized: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  const structuredFromData = extractStructuredContentFromDataParts(serialized);
  if (structuredFromData) {
    return structuredFromData;
  }
  const structuredFromTool = (
    result as vscode.LanguageModelToolResult & { structuredContent?: unknown }
  ).structuredContent;
  if (isPlainObject(structuredFromTool)) {
    return structuredFromTool as Record<string, unknown>;
  }
  return undefined;
}

function isLanguageModelToolResult(value: unknown): value is vscode.LanguageModelToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as { content?: unknown };
  return Array.isArray(record.content);
}

function buildFindTextInFilesToolDefinition(): CustomToolDefinition {
  const inputSchema = LM_FIND_TEXT_IN_FILES_SCHEMA;
  const description = LM_FIND_TEXT_IN_FILES_DESCRIPTION;
  return {
    name: FIND_TEXT_IN_FILES_TOOL_NAME,
    description,
    tags: [],
    inputSchema,
    isCustom: true,
    invoke: runFindTextInFilesTool,
  };
}

function buildFindFilesToolDefinition(): CustomToolDefinition {
  const inputSchema = LM_FIND_FILES_SCHEMA;
  const description = LM_FIND_FILES_DESCRIPTION;
  return {
    name: FIND_FILES_TOOL_NAME,
    description,
    tags: [],
    inputSchema,
    isCustom: true,
    invoke: runFindFilesTool,
  };
}

function buildGetDiagnosticsToolDefinition(): CustomToolDefinition {
  return {
    name: LM_GET_DIAGNOSTICS_TOOL_NAME,
    description: LM_GET_DIAGNOSTICS_DESCRIPTION,
    tags: [],
    inputSchema: LM_GET_DIAGNOSTICS_SCHEMA,
    isCustom: true,
    invoke: runGetDiagnosticsTool,
  };
}

function buildTasksRunBuildToolDefinition(): CustomToolDefinition {
  return {
    name: LM_TASKS_RUN_BUILD_TOOL_NAME,
    description: LM_TASKS_RUN_BUILD_DESCRIPTION,
    tags: [],
    inputSchema: LM_TASKS_RUN_BUILD_SCHEMA,
    isCustom: true,
    invoke: runTasksRunBuildTool,
  };
}

function buildTasksRunTestToolDefinition(): CustomToolDefinition {
  return {
    name: LM_TASKS_RUN_TEST_TOOL_NAME,
    description: LM_TASKS_RUN_TEST_DESCRIPTION,
    tags: [],
    inputSchema: LM_TASKS_RUN_TEST_SCHEMA,
    isCustom: true,
    invoke: runTasksRunTestTool,
  };
}

function buildDebugListLaunchConfigsToolDefinition(): CustomToolDefinition {
  return {
    name: LM_DEBUG_LIST_LAUNCH_CONFIGS_TOOL_NAME,
    description: LM_DEBUG_LIST_LAUNCH_CONFIGS_DESCRIPTION,
    tags: [],
    inputSchema: LM_DEBUG_LIST_LAUNCH_CONFIGS_SCHEMA,
    isCustom: true,
    invoke: runDebugListLaunchConfigsTool,
  };
}

function buildDebugStartToolDefinition(): CustomToolDefinition {
  return {
    name: LM_DEBUG_START_TOOL_NAME,
    description: LM_DEBUG_START_DESCRIPTION,
    tags: [],
    inputSchema: LM_DEBUG_START_SCHEMA,
    isCustom: true,
    invoke: runDebugStartTool,
  };
}

function buildQgrepSearchToolDefinition(): CustomToolDefinition {
  return {
    name: LM_QGREP_SEARCH_TOOL_NAME,
    description: LM_QGREP_SEARCH_DESCRIPTION,
    tags: [],
    inputSchema: LM_QGREP_SEARCH_SCHEMA,
    isCustom: true,
    invoke: runQgrepSearchTool,
  };
}

function buildQgrepGetStatusToolDefinition(): CustomToolDefinition {
  return {
    name: LM_QGREP_GET_STATUS_TOOL_NAME,
    description: LM_QGREP_GET_STATUS_DESCRIPTION,
    tags: [],
    inputSchema: LM_QGREP_GET_STATUS_SCHEMA,
    isCustom: true,
    invoke: runQgrepGetStatusTool,
  };
}

function buildQgrepFilesToolDefinition(): CustomToolDefinition {
  return {
    name: LM_QGREP_FILES_TOOL_NAME,
    description: LM_QGREP_FILES_DESCRIPTION,
    tags: [],
    inputSchema: LM_QGREP_FILES_SCHEMA,
    isCustom: true,
    invoke: runQgrepFilesTool,
  };
}

function buildCustomToolResult(
  text: string,
  structuredContent: unknown,
): vscode.LanguageModelToolResult {
  if (!isPlainObject(structuredContent)) {
    throw new Error('Custom tool must provide structuredContent as a JSON object.');
  }
  const result = {
    content: [new vscode.LanguageModelTextPart(text)],
    structuredContent: structuredContent as Record<string, unknown>,
  };
  return result as unknown as vscode.LanguageModelToolResult;
}

async function runFindTextInFilesTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  const payload = await executeFindTextInFilesSearch(input);
  return buildCustomToolResult(formatFindTextInFilesSummary(payload), payload);
}

async function runFindFilesTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  const payload = await executeFindFilesSearch(input);
  return buildCustomToolResult(formatFindFilesSummary(payload), payload);
}

async function runGetDiagnosticsTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  const getDiagnostics = (
    vscode.languages as { getDiagnostics?: typeof vscode.languages.getDiagnostics }
  ).getDiagnostics;
  if (typeof getDiagnostics !== 'function') {
    throw new Error('vscode.languages.getDiagnostics is not available in this VS Code version.');
  }

  const requestedFilePaths = parseLmGetDiagnosticsFilePaths(input.filePaths);

  const severities = parseLmGetDiagnosticsSeverities(input.severities);
  const severitySet = new Set<LmGetDiagnosticsSeverity>(severities);
  const maxResults = parseLmGetDiagnosticsMaxResults(input.maxResults);
  const diagnosticsByUri: ReadonlyArray<readonly [vscode.Uri, readonly vscode.Diagnostic[]]> =
    requestedFilePaths && requestedFilePaths.length > 0
    ? getDiagnosticsForFilePaths(getDiagnostics, requestedFilePaths)
    : getDiagnostics();
  const scope: LmGetDiagnosticsPayload['scope'] =
    !requestedFilePaths || requestedFilePaths.length === 0
      ? 'workspace+external'
      : requestedFilePaths.length === 1
        ? 'single-file'
        : 'multi-file';

  const files = await collectLmGetDiagnosticsFiles(diagnosticsByUri, severitySet);
  const totalDiagnostics = files.reduce((count, file) => count + file.diagnostics.length, 0);
  const limited = applyLmGetDiagnosticsLimit(files, maxResults);
  const payload: LmGetDiagnosticsPayload = {
    source: 'vscode.languages.getDiagnostics',
    scope,
    severities,
    capped: limited.capped,
    totalDiagnostics,
    files: limited.files,
  };
  const summaryText = formatLmGetDiagnosticsSummary(payload, limited.returnedDiagnostics);
  return buildCustomToolResult(summaryText, payload);
}

async function runTasksRunBuildTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  return runTaskTool('build', input);
}

async function runTasksRunTestTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  return runTaskTool('test', input);
}

async function runTaskTool(
  kind: TaskToolKind,
  input: Record<string, unknown>,
): Promise<vscode.LanguageModelToolResult> {
  const workspaceFolderSelector = parseOptionalStringInput(input, 'workspaceFolder');
  const workspaceFolder = resolveWorkspaceFolderFromSelector(workspaceFolderSelector);
  const tasks = await vscode.tasks.fetchTasks();
  const scopedTasks = filterTasksByWorkspaceFolder(tasks, workspaceFolder);
  const selectedTask = pickPreferredTaskByKind(scopedTasks, kind, workspaceFolder);
  await vscode.tasks.executeTask(selectedTask);
  const payload: TaskRunPayload = {
    started: true,
    kind,
    taskName: selectedTask.name,
    source: selectedTask.source,
    scope: getTaskScopeLabel(selectedTask.scope),
    workspaceFolder: resolveTaskWorkspaceFolderPath(selectedTask.scope, workspaceFolder),
    message: `${capitalize(kind)} task started.`,
  };
  return buildCustomToolResult(formatTaskRunSummary(payload), payload);
}

async function runDebugListLaunchConfigsTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  const workspaceFolderSelector = parseOptionalStringInput(input, 'workspaceFolder');
  const workspaceFolder = resolveWorkspaceFolderFromSelector(workspaceFolderSelector);
  const configs = collectLaunchConfigEntries(workspaceFolder);
  const payload: DebugListLaunchConfigsPayload = {
    count: configs.length,
    configs: configs.map((entry) => entry.summary),
    message: configs.length > 0
      ? `Found ${configs.length} launch configuration(s).`
      : 'No launch configurations found.',
  };
  return buildCustomToolResult(formatDebugListLaunchConfigsSummary(payload), payload);
}

async function runDebugStartTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  const workspaceFolderSelector = parseOptionalStringInput(input, 'workspaceFolder');
  const workspaceFolder = resolveWorkspaceFolderFromSelector(workspaceFolderSelector);
  const index = parseOptionalNonNegativeInteger(input.index, 'index');
  const name = parseOptionalStringInput(input, 'name');
  const noDebug = parseOptionalBoolean(input.noDebug, 'noDebug') ?? false;
  const configs = collectLaunchConfigEntries(workspaceFolder);
  if (configs.length === 0) {
    throw new Error('No launch configurations found.');
  }
  const selected = selectLaunchConfig(configs, index, name);
  const debugTarget = selected.summary.scope === 'workspace' ? undefined : selected.workspaceFolder;
  const started = await vscode.debug.startDebugging(debugTarget, selected.config, { noDebug });
  if (!started) {
    throw new Error('VS Code rejected debug start request.');
  }
  const payload: DebugStartPayload = {
    started: true,
    noDebug,
    selectedConfig: selected.summary,
    message: noDebug ? 'Debug configuration started with noDebug=true.' : 'Debug configuration started.',
  };
  return buildCustomToolResult(formatDebugStartSummary(payload), payload);
}

async function runQgrepSearchTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  const payload = await executeQgrepSearch(input);
  return buildCustomToolResult(formatQgrepSearchSummary(payload), payload);
}

async function runQgrepGetStatusTool(_input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  const status = getQgrepStatusSummary();
  const payload = buildQgrepGetStatusPayload(status);
  return buildCustomToolResult(formatQgrepGetStatusSummary(payload), payload);
}

async function runQgrepFilesTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  const payload = await executeQgrepFilesSearch(input);
  return buildCustomToolResult(formatQgrepFilesSummary(payload), payload);
}

function parseOptionalStringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string when provided.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${key} must be a non-empty string when provided.`);
  }
  return trimmed;
}

function parseOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean when provided.`);
  }
  return value;
}

function parseOptionalNonNegativeInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number when provided.`);
  }
  const rounded = Math.floor(value);
  if (rounded < 0 || rounded !== value) {
    throw new Error(`${key} must be a non-negative integer when provided.`);
  }
  return rounded;
}

function normalizeWorkspaceSelectorPath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveWorkspaceFolderFromSelector(selector: string | undefined): vscode.WorkspaceFolder | undefined {
  if (!selector) {
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new Error('No workspace folders are available.');
  }
  const byName = folders.filter((folder) => folder.name === selector);
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    throw new Error(`workspaceFolder is ambiguous by name: ${selector}`);
  }
  const normalizedSelectorPath = normalizeWorkspaceSelectorPath(selector);
  const byPath = folders.filter((folder) => {
    return normalizeWorkspaceSelectorPath(folder.uri.fsPath) === normalizedSelectorPath;
  });
  if (byPath.length === 1) {
    return byPath[0];
  }
  if (byPath.length > 1) {
    throw new Error(`workspaceFolder is ambiguous by path: ${selector}`);
  }
  throw new Error(`workspaceFolder not found: ${selector}`);
}

function isWorkspaceFolderScope(scope: unknown): scope is vscode.WorkspaceFolder {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return false;
  }
  const candidate = scope as { uri?: unknown; name?: unknown };
  return candidate.uri instanceof vscode.Uri && typeof candidate.name === 'string';
}

function getTaskGroupId(group: vscode.TaskGroup | string | undefined): string | undefined {
  if (!group) {
    return undefined;
  }
  if (typeof group === 'string') {
    return group;
  }
  const id = (group as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function isTaskGroupDefault(group: vscode.TaskGroup | string | undefined): boolean {
  if (!group || typeof group === 'string') {
    return false;
  }
  return (group as { isDefault?: unknown }).isDefault === true;
}

function filterTasksByWorkspaceFolder(
  tasks: readonly vscode.Task[],
  workspaceFolder: vscode.WorkspaceFolder | undefined,
): vscode.Task[] {
  if (!workspaceFolder) {
    return [...tasks];
  }
  const selectedPath = normalizeWorkspaceSelectorPath(workspaceFolder.uri.fsPath);
  return tasks.filter((task) => {
    return getTaskWorkspaceMatchTier(task, selectedPath) !== undefined;
  });
}

function getTaskWorkspaceMatchTier(task: vscode.Task, selectedWorkspacePath: string): number | undefined {
  if (isWorkspaceFolderScope(task.scope)) {
    return normalizeWorkspaceSelectorPath(task.scope.uri.fsPath) === selectedWorkspacePath ? 0 : undefined;
  }
  if (task.scope === vscode.TaskScope.Workspace) {
    return 1;
  }
  return undefined;
}

function pickPreferredTaskByKind(
  tasks: readonly vscode.Task[],
  kind: TaskToolKind,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
): vscode.Task {
  const kindLabel = kind === 'build' ? 'Build' : 'Test';
  const matches = tasks.filter((task) => getTaskGroupId(task.group) === kind);
  if (matches.length === 0) {
    throw new Error(`No ${kindLabel.toLowerCase()} task found. Configure a default ${kindLabel.toLowerCase()} task first.`);
  }
  const selectedWorkspacePath = workspaceFolder
    ? normalizeWorkspaceSelectorPath(workspaceFolder.uri.fsPath)
    : undefined;
  const sorted = [...matches].sort((left, right) => {
    if (selectedWorkspacePath) {
      const leftTier = getTaskWorkspaceMatchTier(left, selectedWorkspacePath) ?? Number.MAX_SAFE_INTEGER;
      const rightTier = getTaskWorkspaceMatchTier(right, selectedWorkspacePath) ?? Number.MAX_SAFE_INTEGER;
      const tierDiff = leftTier - rightTier;
      if (tierDiff !== 0) {
        return tierDiff;
      }
    }
    const defaultDiff = Number(isTaskGroupDefault(right.group)) - Number(isTaskGroupDefault(left.group));
    if (defaultDiff !== 0) {
      return defaultDiff;
    }
    const nameDiff = left.name.localeCompare(right.name);
    if (nameDiff !== 0) {
      return nameDiff;
    }
    return left.source.localeCompare(right.source);
  });
  return sorted[0];
}

function getTaskScopeLabel(scope: vscode.TaskScope | vscode.WorkspaceFolder | undefined): string {
  if (scope === undefined) {
    return 'unknown';
  }
  if (scope === vscode.TaskScope.Global) {
    return 'global';
  }
  if (scope === vscode.TaskScope.Workspace) {
    return 'workspace';
  }
  if (isWorkspaceFolderScope(scope)) {
    return `workspaceFolder:${scope.name}`;
  }
  return 'unknown';
}

function resolveTaskWorkspaceFolderPath(
  scope: vscode.TaskScope | vscode.WorkspaceFolder | undefined,
  fallback: vscode.WorkspaceFolder | undefined,
): string | null {
  if (scope === undefined) {
    return fallback ? fallback.uri.fsPath : null;
  }
  if (isWorkspaceFolderScope(scope)) {
    return scope.uri.fsPath;
  }
  if (fallback) {
    return fallback.uri.fsPath;
  }
  return null;
}

function formatTaskRunSummary(payload: TaskRunPayload): string {
  return [
    `${capitalize(payload.kind)} task execution`,
    `started: ${String(payload.started)}`,
    `taskName: ${payload.taskName}`,
    `source: ${payload.source}`,
    `scope: ${payload.scope}`,
    `workspaceFolder: ${payload.workspaceFolder ?? '-'}`,
    payload.message,
  ].join('\n');
}

function collectLaunchConfigEntries(workspaceFolder: vscode.WorkspaceFolder | undefined): LaunchConfigEntry[] {
  const folders = workspaceFolder
    ? [workspaceFolder]
    : (vscode.workspace.workspaceFolders ?? []);
  const entries: LaunchConfigEntry[] = [];
  for (const folder of folders) {
    const folderConfigs = getWorkspaceFolderLaunchConfigurations(folder);
    for (const rawConfig of folderConfigs) {
      const entry = toLaunchConfigEntry(rawConfig, 'workspaceFolder', folder);
      if (entry) {
        entries.push(entry);
      }
    }
  }
  const workspaceConfigs = getWorkspaceLaunchConfigurations();
  for (const rawConfig of workspaceConfigs) {
    const entry = toLaunchConfigEntry(rawConfig, 'workspace', undefined);
    if (entry) {
      entries.push(entry);
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    entries[index].summary.index = index;
  }
  return entries;
}

function getWorkspaceFolderLaunchConfigurations(folder: vscode.WorkspaceFolder): readonly unknown[] {
  const inspected = vscode.workspace.getConfiguration('launch', folder.uri).inspect<unknown>('configurations');
  return Array.isArray(inspected?.workspaceFolderValue) ? inspected.workspaceFolderValue : [];
}

function getWorkspaceLaunchConfigurations(): readonly unknown[] {
  const inspected = vscode.workspace.getConfiguration('launch').inspect<unknown>('configurations');
  return Array.isArray(inspected?.workspaceValue) ? inspected.workspaceValue : [];
}

function toLaunchConfigEntry(
  rawConfig: unknown,
  scope: LaunchConfigSummary['scope'],
  workspaceFolder: vscode.WorkspaceFolder | undefined,
): LaunchConfigEntry | undefined {
  if (!isPlainObject(rawConfig)) {
    return undefined;
  }
  const name = typeof rawConfig.name === 'string' ? rawConfig.name : '';
  const type = typeof rawConfig.type === 'string' ? rawConfig.type : '';
  const request = typeof rawConfig.request === 'string' ? rawConfig.request : '';
  if (!name || !type || !request) {
    return undefined;
  }
  return {
    summary: {
      index: -1,
      name,
      type,
      request,
      scope,
      workspaceFolder: workspaceFolder ? workspaceFolder.uri.fsPath : null,
    },
    workspaceFolder,
    config: rawConfig as vscode.DebugConfiguration,
  };
}

function selectLaunchConfig(
  entries: readonly LaunchConfigEntry[],
  index: number | undefined,
  name: string | undefined,
): LaunchConfigEntry {
  if (index !== undefined) {
    const byIndex = entries.find((entry) => entry.summary.index === index);
    if (!byIndex) {
      throw new Error(`Launch configuration index out of range: ${index}`);
    }
    return byIndex;
  }
  if (name !== undefined) {
    const byName = entries.filter((entry) => entry.summary.name === name);
    if (byName.length === 0) {
      throw new Error(`Launch configuration not found by name: ${name}`);
    }
    if (byName.length > 1) {
      throw new Error(buildLaunchConfigNameAmbiguousError(name, byName.map((entry) => entry.summary)));
    }
    return byName[0];
  }
  return entries[0];
}

function buildLaunchConfigNameAmbiguousError(name: string, matches: readonly LaunchConfigSummary[]): string {
  const details = matches
    .map((summary) => {
      return `[${summary.index}] scope=${summary.scope} workspaceFolder=${summary.workspaceFolder ?? '-'} type=${summary.type} request=${summary.request}`;
    })
    .join('; ');
  return `Launch configuration name is ambiguous: ${name}. Matches: ${details}. Use index or workspaceFolder to disambiguate.`;
}

function formatDebugListLaunchConfigsSummary(payload: DebugListLaunchConfigsPayload): string {
  const lines: string[] = [
    'Launch configuration list',
    `count: ${payload.count}`,
  ];
  if (payload.configs.length === 0) {
    lines.push(payload.message);
    return lines.join('\n');
  }
  for (const config of payload.configs) {
    lines.push('---');
    lines.push(`[${config.index}] ${config.name}`);
    lines.push(`type: ${config.type} request: ${config.request}`);
    lines.push(`scope: ${config.scope}`);
    lines.push(`workspaceFolder: ${config.workspaceFolder ?? '-'}`);
  }
  return lines.join('\n');
}

function formatDebugStartSummary(payload: DebugStartPayload): string {
  return [
    'Debug start result',
    `started: ${String(payload.started)}`,
    `noDebug: ${String(payload.noDebug)}`,
    `selectedIndex: ${payload.selectedConfig.index}`,
    `selectedName: ${payload.selectedConfig.name}`,
    `selectedType: ${payload.selectedConfig.type}`,
    `selectedRequest: ${payload.selectedConfig.request}`,
    `selectedScope: ${payload.selectedConfig.scope}`,
    `workspaceFolder: ${payload.selectedConfig.workspaceFolder ?? '-'}`,
    payload.message,
  ].join('\n');
}

function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function formatFindTextInFilesSummary(payload: Record<string, unknown>): string {
  const uniqueMatches = typeof payload.uniqueMatches === 'number' ? payload.uniqueMatches : 0;
  const totalMatches = typeof payload.totalMatches === 'number' ? payload.totalMatches : 0;
  const capped = payload.capped === true;
  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  const lines: string[] = [
    'Find text in files summary',
    `uniqueMatches: ${uniqueMatches}`,
    `totalMatches: ${totalMatches}${capped ? ' (capped)' : ''}`,
  ];
  if (matches.length === 0) {
    lines.push('No matches found.');
    return lines.join('\n');
  }
  for (const entry of matches) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as { path?: unknown; line?: unknown; preview?: unknown };
    const matchPath = typeof record.path === 'string'
      ? toSummaryPathPreferWorkspace(record.path)
      : '<unknown>';
    const line = typeof record.line === 'number' ? record.line : 0;
    const preview = typeof record.preview === 'string' ? record.preview.trimEnd() : '';
    lines.push('---');
    lines.push(`// ${matchPath}:${line}`);
    lines.push(preview);
  }
  return lines.join('\n');
}

function formatFindFilesSummary(payload: Record<string, unknown>): string {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const count = typeof payload.count === 'number' ? payload.count : files.length;
  const lines: string[] = [
    'Find files summary',
    `count: ${count}`,
  ];
  if (files.length === 0) {
    lines.push('No files found.');
    return lines.join('\n');
  }
  for (const file of files) {
    if (typeof file === 'string') {
      lines.push('---');
      lines.push(toSummaryPathPreferWorkspace(file));
    }
  }
  return lines.join('\n');
}

function formatQgrepSearchSummary(payload: Record<string, unknown>): string {
  const count = typeof payload.count === 'number' ? payload.count : 0;
  const capped = payload.capped === true;
  const totalAvailable = typeof payload.totalAvailable === 'number' ? payload.totalAvailable : count;
  const totalAvailableCapped = payload.totalAvailableCapped === true;
  const hardLimitHit = payload.hardLimitHit === true;
  const searchPath = typeof payload.searchPath === 'string' ? payload.searchPath : null;
  const maxResultsApplied = typeof payload.maxResultsApplied === 'number'
    ? payload.maxResultsApplied
    : null;
  const maxResultsRequested = typeof payload.maxResultsRequested === 'number'
    ? payload.maxResultsRequested
    : null;
  const casePolicy = typeof payload.casePolicy === 'string' ? payload.casePolicy : null;
  const caseModeApplied = typeof payload.caseModeApplied === 'string' ? payload.caseModeApplied : null;
  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  const lines: string[] = [
    'Qgrep search summary',
    `count: ${count}/${totalAvailable}${totalAvailableCapped ? '+' : ''}${capped ? ' (capped)' : ''}`,
    ...(hardLimitHit ? ['hardLimitHit: true'] : []),
    ...(maxResultsRequested !== null ? [`maxResultsRequested: ${maxResultsRequested}`] : []),
    ...(maxResultsApplied !== null ? [`maxResultsApplied: ${maxResultsApplied}`] : []),
    ...(casePolicy && caseModeApplied ? [`case: ${casePolicy}/${caseModeApplied}`] : []),
    `scope: ${searchPath ?? 'all initialized workspaces'}`,
  ];
  if (matches.length === 0) {
    lines.push('No matches found.');
    return lines.join('\n');
  }
  for (const entry of matches) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as { workspacePath?: unknown; line?: unknown; preview?: unknown };
    const matchPath = typeof record.workspacePath === 'string' ? record.workspacePath : '<unknown>';
    const line = typeof record.line === 'number' ? record.line : 0;
    const preview = typeof record.preview === 'string' ? record.preview.trimEnd() : '';
    lines.push('---');
    lines.push(`// ${matchPath}:${line}`);
    lines.push(preview);
  }
  return lines.join('\n');
}

function computeQgrepAggregateProgressForTool(status: QgrepStatusSummary): QgrepToolAggregateProgress {
  const initialized = status.workspaceStatuses.filter((entry) => entry.initialized);
  if (initialized.length === 0) {
    return {
      filesKnown: false,
    };
  }

  const allTotalsKnown = initialized.every((entry) => {
    return entry.progressKnown && typeof entry.totalFiles === 'number' && entry.totalFiles >= 0;
  });
  if (allTotalsKnown) {
    let indexedFiles = 0;
    let totalFiles = 0;
    for (const entry of initialized) {
      const total = entry.totalFiles ?? 0;
      const indexed = Math.max(0, Math.min(entry.indexedFiles ?? 0, total));
      indexedFiles += indexed;
      totalFiles += total;
    }
    const percent = totalFiles > 0 ? Math.round((indexedFiles / totalFiles) * 100) : 100;
    return {
      filesKnown: true,
      percent,
      indexedFiles,
      totalFiles,
      remainingFiles: Math.max(totalFiles - indexedFiles, 0),
    };
  }

  const sampledPercents = initialized
    .map((entry) => entry.progressPercent)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (sampledPercents.length === 0) {
    return {
      filesKnown: false,
    };
  }

  const percent = Math.round(
    sampledPercents.reduce((sum, value) => sum + value, 0) / sampledPercents.length,
  );
  return {
    filesKnown: false,
    percent: Math.max(0, Math.min(100, percent)),
  };
}

function buildQgrepGetStatusPayload(status: QgrepStatusSummary): Record<string, unknown> {
  const showAutoInitializationHint = status.totalWorkspaces > 0 && status.initializedWorkspaces === 0;
  return {
    ...status,
    aggregate: computeQgrepAggregateProgressForTool(status),
    autoInitialization: {
      hintActive: showAutoInitializationHint,
      appliesWhen: 'no workspace qgrep index is initialized',
      triggerTools: ['lm_qgrepSearchText', 'lm_qgrepSearchFiles'],
      behavior: 'These query tools auto-initialize qgrep indexes for current workspaces on first use and wait until indexing is ready or timeout.',
      message: showAutoInitializationHint
        ? 'No qgrep indexes are initialized yet. Calling lm_qgrepSearchText or lm_qgrepSearchFiles will auto-initialize indexes for current workspaces and wait until indexing is ready (or timeout).'
        : undefined,
    },
  };
}

function formatQgrepGetStatusSummary(payload: Record<string, unknown>): string {
  const binaryAvailable = payload.binaryAvailable === true;
  const binaryPath = typeof payload.binaryPath === 'string' && payload.binaryPath.length > 0
    ? payload.binaryPath
    : '<none>';
  const totalWorkspaces = typeof payload.totalWorkspaces === 'number' ? payload.totalWorkspaces : 0;
  const initializedWorkspaces = typeof payload.initializedWorkspaces === 'number' ? payload.initializedWorkspaces : 0;
  const watchingWorkspaces = typeof payload.watchingWorkspaces === 'number' ? payload.watchingWorkspaces : 0;
  const aggregate = isPlainObject(payload.aggregate)
    ? payload.aggregate as Record<string, unknown>
    : undefined;
  const workspaceStatuses = Array.isArray(payload.workspaceStatuses) ? payload.workspaceStatuses : [];
  const lines: string[] = [
    'Qgrep status summary',
    `binary: ${binaryAvailable ? 'ok' : 'missing'}`,
    `binaryPath: ${binaryPath}`,
    `workspaces: total=${totalWorkspaces}, initialized=${initializedWorkspaces}, watching=${watchingWorkspaces}`,
  ];

  if (!aggregate) {
    lines.push('aggregate: unavailable');
  } else {
    const filesKnown = aggregate.filesKnown === true;
    const indexedFiles = typeof aggregate.indexedFiles === 'number' ? aggregate.indexedFiles : undefined;
    const totalFiles = typeof aggregate.totalFiles === 'number' ? aggregate.totalFiles : undefined;
    const remainingFiles = typeof aggregate.remainingFiles === 'number' ? aggregate.remainingFiles : undefined;
    const percent = typeof aggregate.percent === 'number' ? aggregate.percent : undefined;
    if (filesKnown && indexedFiles !== undefined && totalFiles !== undefined) {
      const remainingText = remainingFiles !== undefined ? `, remaining=${remainingFiles}` : '';
      lines.push(`aggregate: ${indexedFiles}/${totalFiles} (${percent ?? 0}%)${remainingText}`);
    } else if (percent !== undefined) {
      lines.push(`aggregate: --/-- (${percent}%)`);
    } else if (initializedWorkspaces === 0) {
      lines.push('aggregate: not initialized');
    } else {
      lines.push('aggregate: --/-- (--%)');
    }
  }

  const autoInitialization = isPlainObject(payload.autoInitialization)
    ? payload.autoInitialization as Record<string, unknown>
    : undefined;
  if (autoInitialization?.hintActive === true) {
    const message = typeof autoInitialization.message === 'string' ? autoInitialization.message : undefined;
    if (message && message.length > 0) {
      lines.push(`autoInitialization: ${message}`);
    }
  }

  if (workspaceStatuses.length === 0) {
    lines.push('No workspace folders.');
    return lines.join('\n');
  }

  for (const entry of workspaceStatuses) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const workspaceName = typeof record.workspaceName === 'string' ? record.workspaceName : '<unknown>';
    const initialized = record.initialized === true;
    const watching = record.watching === true;
    const indexing = record.indexing === true;
    const progressKnown = record.progressKnown === true;
    const indexedFiles = typeof record.indexedFiles === 'number' ? record.indexedFiles : undefined;
    const totalFiles = typeof record.totalFiles === 'number' ? record.totalFiles : undefined;
    const percent = typeof record.progressPercent === 'number' ? record.progressPercent : undefined;
    lines.push('---');
    if (!initialized) {
      lines.push(`${workspaceName}: not initialized`);
      continue;
    }
    if (progressKnown && indexedFiles !== undefined && totalFiles !== undefined) {
      lines.push(
        `${workspaceName}: ${indexedFiles}/${totalFiles} (${percent ?? 0}%), watching=${watching}, indexing=${indexing}`,
      );
      continue;
    }
    if (percent !== undefined) {
      lines.push(`${workspaceName}: --/-- (${percent}%), watching=${watching}, indexing=${indexing}`);
      continue;
    }
    lines.push(`${workspaceName}: --/-- (--%), watching=${watching}, indexing=${indexing}`);
  }
  return lines.join('\n');
}

function formatQgrepFilesSummary(payload: Record<string, unknown>): string {
  const count = typeof payload.count === 'number' ? payload.count : 0;
  const capped = payload.capped === true;
  const totalAvailable = typeof payload.totalAvailable === 'number' ? payload.totalAvailable : count;
  const totalAvailableCapped = payload.totalAvailableCapped === true;
  const hardLimitHit = payload.hardLimitHit === true;
  const searchPath = typeof payload.searchPath === 'string' ? payload.searchPath : null;
  const mode = typeof payload.mode === 'string' ? payload.mode : 'fp';
  const maxResultsApplied = typeof payload.maxResultsApplied === 'number'
    ? payload.maxResultsApplied
    : null;
  const maxResultsRequested = typeof payload.maxResultsRequested === 'number'
    ? payload.maxResultsRequested
    : null;
  const querySemanticsApplied = typeof payload.querySemanticsApplied === 'string'
    ? payload.querySemanticsApplied
    : null;
  const files = Array.isArray(payload.files) ? payload.files : [];
  const lines: string[] = [
    'Qgrep files summary',
    `mode: ${mode}`,
    ...(querySemanticsApplied ? [`querySemanticsApplied: ${querySemanticsApplied}`] : []),
    `count: ${count}/${totalAvailable}${totalAvailableCapped ? '+' : ''}${capped ? ' (capped)' : ''}`,
    ...(hardLimitHit ? ['hardLimitHit: true'] : []),
    ...(maxResultsRequested !== null ? [`maxResultsRequested: ${maxResultsRequested}`] : []),
    ...(maxResultsApplied !== null ? [`maxResultsApplied: ${maxResultsApplied}`] : []),
    `scope: ${searchPath ?? 'all initialized workspaces'}`,
  ];
  if (files.length === 0) {
    lines.push('No files found.');
    return lines.join('\n');
  }
  for (const entry of files) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as { workspacePath?: unknown; absolutePath?: unknown };
    const value = typeof record.workspacePath === 'string'
      ? record.workspacePath
      : typeof record.absolutePath === 'string'
        ? toSummaryPathPreferWorkspace(record.absolutePath)
        : '<unknown>';
    lines.push('---');
    lines.push(value);
  }
  return lines.join('\n');
}

function getDiagnosticsForFilePaths(
  getDiagnostics: typeof vscode.languages.getDiagnostics,
  filePaths: readonly string[],
): ReadonlyArray<readonly [vscode.Uri, readonly vscode.Diagnostic[]]> {
  const entries: Array<readonly [vscode.Uri, readonly vscode.Diagnostic[]]> = [];
  const seenUris = new Set<string>();
  for (const filePath of filePaths) {
    const resolved = resolveInputFilePath(filePath);
    const uri = vscode.Uri.file(resolved.absoluteFilePath);
    const key = uri.toString();
    if (seenUris.has(key)) {
      continue;
    }
    seenUris.add(key);
    entries.push([uri, getDiagnostics(uri)]);
  }
  return entries;
}

async function collectLmGetDiagnosticsFiles(
  entries: ReadonlyArray<readonly [vscode.Uri, readonly vscode.Diagnostic[]]>,
  severities: ReadonlySet<LmGetDiagnosticsSeverity>,
): Promise<LmGetDiagnosticsFileResult[]> {
  const files: LmGetDiagnosticsFileResult[] = [];
  const lineCache = new Map<string, string[] | null>();
  for (const [uri, diagnostics] of entries) {
    const filePath = resolveLmGetDiagnosticsFilePath(uri);
    const normalizedDiagnostics: LmGetDiagnosticsNormalizedDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
      const normalized = await normalizeDiagnosticForLmGetDiagnostics(
        diagnostic,
        filePath.readableFilePath,
        lineCache,
      );
      if (!severities.has(normalized.severity)) {
        continue;
      }
      normalizedDiagnostics.push(normalized);
    }
    normalizedDiagnostics.sort(compareLmGetDiagnostics);
    if (normalizedDiagnostics.length === 0) {
      continue;
    }
    files.push({
      absolutePath: filePath.absolutePath,
      diagnostics: normalizedDiagnostics,
    });
  }
  files.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
  return files;
}

function resolveLmGetDiagnosticsFilePath(uri: vscode.Uri): {
  absolutePath: string;
  readableFilePath: string | null;
} {
  const fsPath = uri.fsPath.trim();
  if (uri.scheme === 'file' && fsPath.length > 0) {
    const absolutePath = normalizeLmGetDiagnosticsPath(path.resolve(fsPath));
    return {
      absolutePath,
      readableFilePath: path.resolve(fsPath),
    };
  }
  if (fsPath.length > 0 && (path.isAbsolute(fsPath) || startsWithWindowsAbsolutePath(fsPath))) {
    return {
      absolutePath: normalizeLmGetDiagnosticsPath(path.resolve(fsPath)),
      readableFilePath: path.resolve(fsPath),
    };
  }
  return {
    absolutePath: uri.toString(),
    readableFilePath: null,
  };
}

function normalizeLmGetDiagnosticsPath(value: string): string {
  return value.replace(/\\/g, '/');
}

async function normalizeDiagnosticForLmGetDiagnostics(
  diagnostic: vscode.Diagnostic,
  readableFilePath: string | null,
  lineCache: Map<string, string[] | null>,
): Promise<LmGetDiagnosticsNormalizedDiagnostic> {
  const startLine = diagnostic.range.start.line + 1;
  const startCharacter = diagnostic.range.start.character + 1;
  const endLine = diagnostic.range.end.line + 1;
  const endCharacter = diagnostic.range.end.character + 1;
  const previewInfo = await readRangePreviewFromFile(
    readableFilePath,
    startLine,
    endLine,
    lineCache,
  );
  return {
    severity: mapDiagnosticSeverityToLmGetDiagnostics(diagnostic.severity),
    message: sanitizeLmGetDiagnosticsMessage(diagnostic.message),
    source: typeof diagnostic.source === 'string' && diagnostic.source.length > 0
      ? diagnostic.source
      : null,
    code: normalizeLmGetDiagnosticsDiagnosticCode(diagnostic.code),
    startLine,
    startCharacter,
    endLine,
    endCharacter,
    tags: normalizeLmGetDiagnosticsTags(diagnostic.tags),
    preview: previewInfo.preview,
    previewUnavailable: previewInfo.previewUnavailable,
    previewTruncated: previewInfo.previewTruncated,
  };
}

function normalizePreviewRange(startLine: number, endLine: number): { startLine: number; endLine: number } {
  const normalizedStart = Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : 1;
  const normalizedEndRaw = Number.isFinite(endLine) ? Math.max(1, Math.floor(endLine)) : normalizedStart;
  const normalizedEnd = Math.max(normalizedStart, normalizedEndRaw);
  return {
    startLine: normalizedStart,
    endLine: normalizedEnd,
  };
}

function computePreviewEndLine(
  startLine: number,
  endLine: number,
  maxLines: number,
): { effectiveEndLine: number; truncated: boolean } {
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  const maxEndLine = startLine + safeMaxLines - 1;
  if (endLine > maxEndLine) {
    return {
      effectiveEndLine: maxEndLine,
      truncated: true,
    };
  }
  return {
    effectiveEndLine: endLine,
    truncated: false,
  };
}

async function readRangePreviewFromFile(
  readableFilePath: string | null,
  startLine: number,
  endLine: number,
  lineCache: Map<string, string[] | null>,
): Promise<{ preview: string; previewUnavailable: boolean; previewTruncated: boolean }> {
  if (!readableFilePath) {
    return {
      preview: '',
      previewUnavailable: true,
      previewTruncated: false,
    };
  }
  const lines = await getLmGetDiagnosticsFileLines(readableFilePath, lineCache);
  if (!lines || lines.length === 0) {
    return {
      preview: '',
      previewUnavailable: true,
      previewTruncated: false,
    };
  }
  const normalizedRange = normalizePreviewRange(startLine, endLine);
  const safeStart = Math.min(normalizedRange.startLine, lines.length);
  const safeEnd = Math.min(Math.max(normalizedRange.endLine, safeStart), lines.length);
  const endWithCap = computePreviewEndLine(safeStart, safeEnd, LM_GET_DIAGNOSTICS_PREVIEW_MAX_LINES);
  const previewLines: string[] = [];
  for (let line = safeStart; line <= endWithCap.effectiveEndLine; line += 1) {
    previewLines.push(lines[line - 1] ?? '');
  }
  return {
    preview: previewLines.join('\n').trimEnd(),
    previewUnavailable: false,
    previewTruncated: endWithCap.truncated,
  };
}

async function getLmGetDiagnosticsFileLines(
  filePath: string,
  cache: Map<string, string[] | null>,
): Promise<string[] | null> {
  if (!cache.has(filePath)) {
    try {
      const uri = vscode.Uri.file(filePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(bytes);
      cache.set(filePath, text.split(/\r?\n/u));
    } catch {
      cache.set(filePath, null);
    }
  }
  return cache.get(filePath) ?? null;
}

function mapDiagnosticSeverityToLmGetDiagnostics(severity: vscode.DiagnosticSeverity): LmGetDiagnosticsSeverity {
  if (severity === vscode.DiagnosticSeverity.Error) {
    return 'error';
  }
  if (severity === vscode.DiagnosticSeverity.Warning) {
    return 'warning';
  }
  if (severity === vscode.DiagnosticSeverity.Hint) {
    return 'hint';
  }
  return 'information';
}

function sanitizeLmGetDiagnosticsMessage(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeLmGetDiagnosticsDiagnosticCode(code: vscode.Diagnostic['code']): string | null {
  if (typeof code === 'string') {
    return code;
  }
  if (typeof code === 'number') {
    return String(code);
  }
  if (code && typeof code === 'object') {
    const value = (code as { value?: unknown }).value;
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }
  return null;
}

function normalizeLmGetDiagnosticsTags(tags: readonly vscode.DiagnosticTag[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }
  const values = new Set<string>();
  for (const tag of tags) {
    if (tag === vscode.DiagnosticTag.Unnecessary) {
      values.add('unnecessary');
      continue;
    }
    if (tag === vscode.DiagnosticTag.Deprecated) {
      values.add('deprecated');
      continue;
    }
    values.add(String(tag));
  }
  return [...values];
}

function compareLmGetDiagnostics(
  left: LmGetDiagnosticsNormalizedDiagnostic,
  right: LmGetDiagnosticsNormalizedDiagnostic,
): number {
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }
  if (left.startCharacter !== right.startCharacter) {
    return left.startCharacter - right.startCharacter;
  }
  if (left.endLine !== right.endLine) {
    return left.endLine - right.endLine;
  }
  if (left.endCharacter !== right.endCharacter) {
    return left.endCharacter - right.endCharacter;
  }
  return left.message.localeCompare(right.message);
}

function parseLmGetDiagnosticsSeverities(input: unknown): LmGetDiagnosticsSeverity[] {
  if (input === undefined) {
    return [...LM_GET_DIAGNOSTICS_DEFAULT_SEVERITIES];
  }
  if (!Array.isArray(input)) {
    throw new Error('severities must be an array when provided.');
  }
  const values: LmGetDiagnosticsSeverity[] = [];
  const seen = new Set<LmGetDiagnosticsSeverity>();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (typeof item !== 'string') {
      throw new Error(`severities[${index}] must be a string.`);
    }
    const normalized = item.trim().toLowerCase();
    if (!isLmGetDiagnosticsSeverity(normalized)) {
      throw new Error(
        `severities[${index}] must be one of: ${LM_GET_DIAGNOSTICS_ALLOWED_SEVERITIES.join(', ')}.`,
      );
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }
  if (values.length === 0) {
    return [...LM_GET_DIAGNOSTICS_DEFAULT_SEVERITIES];
  }
  return values;
}

function parseLmGetDiagnosticsFilePaths(input: unknown): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new Error('filePaths must be an array of strings when provided.');
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (typeof item !== 'string') {
      throw new Error(`filePaths[${index}] must be a string.`);
    }
    const normalized = item.trim();
    if (normalized.length === 0) {
      throw new Error(`filePaths[${index}] must be a non-empty string.`);
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

function isLmGetDiagnosticsSeverity(value: string): value is LmGetDiagnosticsSeverity {
  return (LM_GET_DIAGNOSTICS_ALLOWED_SEVERITIES as readonly string[]).includes(value);
}

function parseLmGetDiagnosticsMaxResults(value: unknown): number {
  if (value === undefined) {
    return LM_GET_DIAGNOSTICS_DEFAULT_MAX_RESULTS;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('maxResults must be a finite number when provided.');
  }
  if (!Number.isInteger(value)) {
    throw new Error('maxResults must be an integer when provided.');
  }
  if (value < LM_GET_DIAGNOSTICS_MIN_MAX_RESULTS) {
    throw new Error(`maxResults must be >= ${LM_GET_DIAGNOSTICS_MIN_MAX_RESULTS}.`);
  }
  return value;
}

function applyLmGetDiagnosticsLimit(
  files: readonly LmGetDiagnosticsFileResult[],
  maxResults: number,
): { files: LmGetDiagnosticsFileResult[]; returnedDiagnostics: number; capped: boolean } {
  const limitedFiles: LmGetDiagnosticsFileResult[] = [];
  let remaining = maxResults;
  let returnedDiagnostics = 0;
  for (const file of files) {
    if (remaining <= 0) {
      break;
    }
    const diagnostics = file.diagnostics.slice(0, remaining);
    if (diagnostics.length === 0) {
      continue;
    }
    limitedFiles.push({
      absolutePath: file.absolutePath,
      diagnostics,
    });
    returnedDiagnostics += diagnostics.length;
    remaining -= diagnostics.length;
  }
  const totalDiagnostics = files.reduce((count, file) => count + file.diagnostics.length, 0);
  return {
    files: limitedFiles,
    returnedDiagnostics,
    capped: totalDiagnostics > returnedDiagnostics,
  };
}

function formatLmGetDiagnosticsSummary(payload: LmGetDiagnosticsPayload, returnedDiagnostics: number): string {
  const lines: string[] = [
    'Diagnostics summary',
    `source: ${payload.source}`,
    `scope: ${payload.scope}`,
    `severities: ${payload.severities.join(', ')}`,
    `files: ${payload.files.length}`,
    `diagnostics: ${returnedDiagnostics}/${payload.totalDiagnostics}${payload.capped ? ' (capped)' : ''}`,
  ];
  if (payload.totalDiagnostics === 0) {
    lines.push('No diagnostics found.');
    return lines.join('\n');
  }
  for (const file of payload.files) {
    lines.push('---');
    lines.push(`file: ${toSummaryPathPreferWorkspace(file.absolutePath)}`);
    for (const diagnostic of file.diagnostics) {
      const codePart = diagnostic.code ? ` code=${diagnostic.code}` : '';
      const sourcePart = diagnostic.source ? ` source=${diagnostic.source}` : '';
      const previewUnavailablePart = diagnostic.previewUnavailable ? ' preview unavailable' : '';
      const previewTruncatedPart = diagnostic.previewTruncated ? ' preview truncated' : '';
      lines.push(
        `[${diagnostic.severity}] ${diagnostic.startLine}:${diagnostic.startCharacter}-${diagnostic.endLine}:${diagnostic.endCharacter}${sourcePart}${codePart}${previewUnavailablePart}${previewTruncatedPart} ${diagnostic.message}`,
      );
    }
  }
  return lines.join('\n');
}

function serializedToolResultPartToText(part: Record<string, unknown>): string {
  if (part.type === 'text' && typeof part.text === 'string') {
    return part.text;
  }
  if (part.type === 'prompt-tsx') {
    if (Array.isArray(part.textParts)) {
      const textParts = part.textParts.filter((item): item is string => typeof item === 'string');
      if (textParts.length > 0) {
        return joinPromptTsxTextParts(textParts);
      }
    }
    const value = part.value;
    if (value && typeof value === 'object') {
      const textParts = extractPromptTsxText(value as Record<string, unknown>);
      if (textParts.length > 0) {
        return joinPromptTsxTextParts(textParts);
      }
    }
    return '';
  }
  if (part.type === 'data' && typeof part.text === 'string') {
    return part.text;
  }
  if (part.type === 'unknown' && typeof part.text === 'string') {
    return part.text;
  }
  return '';
}

function toolResultContentToText(content: readonly unknown[]): string {
  const parts: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (item instanceof vscode.LanguageModelTextPart) {
      parts.push({ type: 'text', text: item.value });
      continue;
    }
    if (item instanceof vscode.LanguageModelPromptTsxPart) {
      const textParts = extractPromptTsxText(item.value);
      parts.push({ type: 'prompt-tsx', textParts });
      continue;
    }
    if (item instanceof vscode.LanguageModelDataPart) {
      const decodedText = decodeTextData(item);
      if (decodedText !== undefined) {
        parts.push({ type: 'data', text: decodedText });
      }
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (typeof record.type === 'string') {
        parts.push(record);
      }
    }
  }
  return serializedToolResultToText(parts);
}

function decodeTextData(part: vscode.LanguageModelDataPart): string | undefined {
  if (part.mimeType.startsWith('text/') || isJsonMimeType(part.mimeType)) {
    return new TextDecoder('utf-8').decode(part.data);
  }

  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function safePrettyStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function unescapeNewlines(text: string): string {
  return text.replace(/\\r\\n/g, '\r\n').replace(/\\n/g, '\n');
}

function getToolUri(name: string): string {
  return `lm-tools://tool/${name}`;
}

function getSchemaUri(name: string): string {
  return `lm-tools://schema/${name}`;
}

function getToolUsageHint(tool: ExposedTool): Record<string, unknown> {
  const combined = `${tool.name} ${(tool.description ?? '')}`.toLowerCase();
  if (combined.includes('do not use') || combined.includes('placeholder')) {
    return {
      mode: 'do-not-use',
      reason: 'Heuristic: description indicates do-not-use/placeholder.',
    };
  }

  if (tool.tags.some((tag) => tag.includes('codesearch'))) {
    return {
      mode: 'direct',
      reason: 'Heuristic: codesearch tag; call the tool directly.',
    };
  }

  return {
    mode: 'direct',
    reason: 'Heuristic: default to calling the tool directly.',
    requiresObjectInput: schemaRequiresObjectInput(tool.inputSchema) || undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaRequiresObjectInput(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') {
    return false;
  }

  const record = schema as Record<string, unknown>;
  if (record.type === 'object' || typeof record.properties === 'object') {
    return true;
  }
  const properties = record.properties && typeof record.properties === 'object'
    ? Object.values(record.properties as Record<string, unknown>)
    : [];
  for (const propSchema of properties) {
    if (schemaHasObject(propSchema)) {
      return true;
    }
  }

  return false;
}

function schemaHasObject(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') {
    return false;
  }

  const record = schema as Record<string, unknown>;
  if (record.type === 'object' || typeof record.properties === 'object') {
    return true;
  }
  if (record.type === 'array' && record.items) {
    return schemaHasObject(record.items);
  }
  if (Array.isArray(record.anyOf) && record.anyOf.some(schemaHasObject)) {
    return true;
  }
  if (Array.isArray(record.oneOf) && record.oneOf.some(schemaHasObject)) {
    return true;
  }

  return false;
}

function formatLogPayload(value: unknown): string {
  return safeStringify(value);
}

function extractPromptTsxText(value: unknown): string[] {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') {
      parts.push(record.text);
    }
    if (record.node !== undefined) {
      visit(record.node);
    }
    if (record.children !== undefined) {
      visit(record.children);
    }
  };

  visit(value);
  return parts;
}

function joinPromptTsxTextParts(parts: readonly string[]): string {
  let result = '';
  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }
    if (result.length === 0) {
      result = part;
      continue;
    }

    const prevChar = result[result.length - 1];
    const nextChar = part[0];
    if (prevChar && nextChar && !/\s/u.test(prevChar) && !/\s/u.test(nextChar)) {
      if (startsWithWindowsAbsolutePath(part) || startsWithListMarker(part)) {
        result += '\n';
      } else if (isWordChar(prevChar) && isWordChar(nextChar)) {
        result += ' ';
      }
    }

    result += part;
  }

  return result;
}

function startsWithWindowsAbsolutePath(text: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(text) || text.startsWith('\\\\');
}

function startsWithListMarker(text: string): boolean {
  return /^(\d+[.)]\s+|[-*•]\s+)/u.test(text);
}

function isWordChar(char: string): boolean {
  return /[0-9A-Za-z_]/u.test(char);
}

function getLanguageModelNamespace(): typeof vscode.lm | undefined {
  const possibleLm = (vscode as { lm?: typeof vscode.lm }).lm;
  return possibleLm;
}

function getAllLmToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const lm = getLanguageModelNamespace();
  return lm ? lm.tools : [];
}

function isCustomTool(tool: ExposedTool): tool is CustomToolDefinition {
  return (tool as CustomToolDefinition).isCustom === true;
}

function getCustomToolsSnapshot(): readonly CustomToolDefinition[] {
  return [
    buildFindFilesToolDefinition(),
    buildFindTextInFilesToolDefinition(),
    buildGetDiagnosticsToolDefinition(),
    buildTasksRunBuildToolDefinition(),
    buildTasksRunTestToolDefinition(),
    buildDebugListLaunchConfigsToolDefinition(),
    buildDebugStartToolDefinition(),
    buildQgrepGetStatusToolDefinition(),
    buildQgrepSearchToolDefinition(),
    buildQgrepFilesToolDefinition(),
  ];
}

function getAllToolsSnapshot(): readonly ExposedTool[] {
  return [...getAllLmToolsSnapshot(), ...getCustomToolsSnapshot()];
}

export function getExposedToolsSnapshot(): readonly ExposedTool[] {
  const exposedSet = new Set(getExposedToolsSetting());
  return getAllToolsSnapshot().filter((tool) => {
    return exposedSet.has(tool.name) && !isBuiltInDisabledTool(tool.name);
  });
}

export function getEnabledExposedToolsSnapshot(): readonly ExposedTool[] {
  const enabledSet = new Set(getEnabledToolsSetting());
  return getExposedToolsSnapshot().filter((tool) => {
    return enabledSet.has(tool.name);
  });
}

export function prioritizeTool(
  tools: readonly ExposedTool[],
  preferredName: string,
): ExposedTool[] {
  const ordered = [...tools];
  ordered.sort((left, right) => {
    if (left.name === preferredName) {
      return -1;
    }
    if (right.name === preferredName) {
      return 1;
    }
    return 0;
  });
  return ordered;
}

export function registerExposedTools(server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer): void {
  const toolInputSchema: z.ZodTypeAny = z.object({}).passthrough()
    .describe('Tool input object. Use lm-tools://schema/{name} for the expected shape.');
  const tools = getEnabledExposedToolsSnapshot();
  for (const tool of tools) {
    if (tool.name === 'getVSCodeWorkspace') {
      continue;
    }
    // @ts-expect-error TS2589: Deep instantiation from SDK tool generics.
    server.registerTool<z.ZodTypeAny, z.ZodTypeAny>(
      tool.name,
      {
        description: tool.description ?? '',
        inputSchema: toolInputSchema,
      },
      async (args: Record<string, unknown>) => invokeExposedTool(tool.name, args),
    );
  }
}

function toolErrorResult(message: string) {
  return buildToolResult({ error: message }, true, message);
}

function toolErrorResultPayload(payload: unknown) {
  const textOverride = isPlainObject(payload) ? formatToolErrorText(payload) : undefined;
  return buildToolResult(payload, true, textOverride);
}

function buildToolResult(
  payload: unknown,
  isError: boolean,
  textOverride?: string,
  structuredOverride?: Record<string, unknown>,
) {
  const text = textOverride ?? payloadToText(payload);
  const structuredContent = structuredOverride ?? (isPlainObject(payload) ? payload : { text });

  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function buildPassthroughToolResult(
  text: string | undefined,
  hasTextPart: boolean,
  structuredContent?: Record<string, unknown>,
  isError = false,
) {
  return {
    content: hasTextPart
      ? [
        {
          type: 'text' as const,
          text: text ?? '',
        },
      ]
      : [],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function toSummaryPathPreferWorkspace(absolutePath: string): string {
  const resolved = resolveStructuredPath(absolutePath);
  return resolved.workspacePath ?? resolved.absolutePath;
}

function isCopilotSearchCodebasePlaceholderResponse(toolName: string, outputText: string | undefined): boolean {
  if (toolName !== COPILOT_SEARCH_CODEBASE_TOOL_NAME) {
    return false;
  }
  if (typeof outputText !== 'string' || outputText.length === 0) {
    return false;
  }
  return outputText.includes(COPILOT_SEARCH_CODEBASE_PLACEHOLDER_RESPONSE);
}

function buildCopilotSearchCodebaseUnavailablePayload(): Record<string, unknown> {
  return {
    error: `Tool '${COPILOT_SEARCH_CODEBASE_TOOL_NAME}' is unavailable because it returned placeholder content instead of meaningful search results.`,
    hint: 'This tool is in an invalid state and should not be called again, because it will not return meaningful results, unless the user explicitly requests it.',
    name: COPILOT_SEARCH_CODEBASE_TOOL_NAME,
  };
}

async function invokeExposedTool(toolName: string, args: unknown) {
  const debugLevel = getDebugLevel();
  const requestStartTime = Date.now();
  let debugInvokeInput: Record<string, unknown> | undefined;
  let debugOutputText: string | undefined;
  let debugStructuredOutput: unknown;
  let debugError: unknown;
  try {
    const tools = getEnabledExposedToolsSnapshot();
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found or disabled: ${toolName}`);
    }
    const input = args ?? {};
    if (!isPlainObject(input)) {
      return toolErrorResultPayload({
        error: 'Tool input must be an object. Use lm-tools://schema/{name} for the expected shape.',
        name: tool.name,
        inputSchema: tool.inputSchema ?? null,
      });
    }
    const normalizedInput = applyInputDefaultsToToolInput(input, tool.inputSchema, tool.name);
    debugInvokeInput = normalizedInput;
    let outputText: string | undefined;
    let structuredOutput: Record<string, unknown> | undefined;
    if (isCustomTool(tool)) {
      const result = await tool.invoke(normalizedInput);
      if (!isLanguageModelToolResult(result)) {
        throw new Error(`Custom tool '${tool.name}' must return LanguageModelToolResult.`);
      }
      const serialized = serializeToolResult(result);
      const textPayload = extractTextPayloadFromTextParts(serialized);
      if (!textPayload.hasTextPart) {
        throw new Error(`Custom tool '${tool.name}' must include LanguageModelTextPart.`);
      }
      structuredOutput = resolveStructuredToolResultPayload(result, serialized);
      if (!structuredOutput) {
        throw new Error(`Custom tool '${tool.name}' must include structuredContent as a JSON object.`);
      }
      outputText = textPayload.text;
      debugOutputText = outputText;
      debugStructuredOutput = structuredOutput;
      return buildPassthroughToolResult(outputText, true, structuredOutput);
    }

    const lm = getLanguageModelNamespace();
    if (!lm) {
      return toolErrorResult('vscode.lm is not available in this VS Code version.');
    }
    const result = await lm.invokeTool(tool.name, {
      input: normalizedInput,
      toolInvocationToken: undefined,
    });
    const serialized = serializeToolResult(result);
    const textPayload = extractTextPayloadFromTextParts(serialized);
    let hasOutputTextPart = textPayload.hasTextPart;
    outputText = hasOutputTextPart ? textPayload.text : undefined;
    structuredOutput = resolveStructuredToolResultPayload(result, serialized);
    if (!hasOutputTextPart) {
      const serializedText = serializedToolResultToText(serialized);
      if (serializedText.length > 0) {
        outputText = serializedText;
        hasOutputTextPart = true;
      }
    }
    if (!hasOutputTextPart && structuredOutput) {
      outputText = safePrettyStringify(structuredOutput);
      hasOutputTextPart = true;
    }
    if (!hasOutputTextPart) {
      outputText = '';
      hasOutputTextPart = true;
    }
    if (isCopilotSearchCodebasePlaceholderResponse(tool.name, outputText)) {
      const unavailablePayload = buildCopilotSearchCodebaseUnavailablePayload();
      debugOutputText = formatToolErrorText(unavailablePayload);
      debugStructuredOutput = unavailablePayload;
      return toolErrorResultPayload(unavailablePayload);
    }
    debugOutputText = outputText;
    debugStructuredOutput = structuredOutput;
    return buildPassthroughToolResult(outputText, hasOutputTextPart, structuredOutput);
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    const message = String(error);
    debugError = error;
    return toolErrorResultPayload({
      error: message,
      name: toolName,
      inputSchema: getEnabledExposedToolsSnapshot().find((tool) => tool.name === toolName)?.inputSchema ?? null,
    });
  } finally {
    const durationMs = Date.now() - requestStartTime;
    if (debugLevel !== 'off') {
      toolingLogger.info(`mcpTool call name=${toolName} input=${formatLogPayload(debugInvokeInput ?? {})} durationMs=${durationMs}`);
    }
    if (debugLevel === 'detail') {
      if (debugError) {
        toolingLogger.info(`mcpTool call name=${toolName} error: ${String(debugError)}`);
      } else {
        toolingLogger.info(`mcpTool call name=${toolName} output: ${debugOutputText ?? ''}`);
        toolingLogger.info(`mcpTool call name=${toolName} structured output: ${formatLogPayload(debugStructuredOutput)}`);
      }
    }
  }
}

function payloadToText(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (Array.isArray(payload)) {
    const segments = payload.map(payloadToText).filter((segment) => segment.length > 0);
    return joinPromptTsxTextParts(segments);
  }
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }
    if (Array.isArray(record.textParts)) {
      const textParts = record.textParts.filter((part): part is string => typeof part === 'string');
      if (textParts.length > 0) {
        return joinPromptTsxTextParts(textParts);
      }
    }
    if (Array.isArray(record.result)) {
      const text = serializedToolResultToText(record.result);
      if (text.length > 0) {
        return text;
      }
    }
    if (Array.isArray(record.tools)) {
      const toolText = toolListToText(record.tools);
      if (toolText.length > 0) {
        return toolText;
      }
    }
    if (Array.isArray(record.content)) {
      const contentText = toolResultContentToText(record.content);
      if (contentText.length > 0) {
        return contentText;
      }
    }
    return unescapeNewlines(safePrettyStringify(record));
  }
  return String(payload);
}

function toolListToText(tools: readonly unknown[]): string {
  const entries: string[] = [];
  for (const tool of tools) {
    if (typeof tool === 'string') {
      entries.push(tool);
      continue;
    }
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const record = tool as Record<string, unknown>;
    if (typeof record.name === 'string' && record.name.length > 0) {
      entries.push(record.name);
      continue;
    }
    const text = formatToolInfoText(record);
    if (text.length > 0) {
      entries.push(text);
    }
  }

  return entries.join('\n');
}

