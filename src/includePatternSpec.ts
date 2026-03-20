export const INCLUDE_PATTERN_SPEC_URI = 'lm-tools://spec/includePattern';
export const INCLUDE_PATTERN_SHARED_SYNTAX_ID = 'lm-tools-bridge/includePattern/v1';
const INCLUDE_PATTERN_SHARED_SYNTAX_KIND = 'workspace-path-or-glob-scope';

export function getIncludePatternFieldDescription(): string {
  return `Optional path or glob scope. Read ${INCLUDE_PATTERN_SPEC_URI} for the shared syntax, examples, and restrictions.`;
}

export function getIncludePatternToolDescriptionSentence(): string {
  return `includePattern uses the shared ${INCLUDE_PATTERN_SPEC_URI} syntax.`;
}

export function getIncludePatternSpecResourceDescription(): string {
  return 'Read the shared includePattern syntax used by workspace tools.';
}

export function getIncludePatternSpecReadHint(): string {
  return `Before using any tool argument named includePattern, you must read ${INCLUDE_PATTERN_SPEC_URI} first.`;
}

export function buildIncludePatternSchema(options?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'string',
    description: getIncludePatternFieldDescription(),
    'x-lm-tools-bridge-sharedSyntax': {
      id: INCLUDE_PATTERN_SHARED_SYNTAX_ID,
      uri: INCLUDE_PATTERN_SPEC_URI,
      kind: INCLUDE_PATTERN_SHARED_SYNTAX_KIND,
    },
    ...(options ?? {}),
  };
}

export function getIncludePatternSpecText(): string {
  return [
    'Shared includePattern syntax',
    '',
    'Applies to:',
    '- lm_findTextInFiles.includePattern',
    '- lm_qgrepSearchText.includePattern',
    '- lm_getDiagnostics.includePattern',
    '',
    'Accepted forms:',
    '- Workspace-relative path or glob, for example src/**/*.ts, **/*.as, *.{h,cpp}.',
    '- Single-workspace scope, for example Engine/** or Engine/Source/**/*.{h,cpp}.',
    '- Selected workspace set, for example {Game,Engine}/**/*.{h,cpp}.',
    '- Mixed top-level brace branches, for example {Game/Source/**/*.h,Engine/Script/**/*.as,src/**/*.ts}.',
    '- Absolute path or absolute glob inside the current workspaces, for example C:/Repo/Source/**/*.cpp.',
    '',
    'Rules:',
    '- Use VS Code glob semantics.',
    '- * is not recursive; ** is recursive.',
    '- Brace globs such as *.{h,cpp} and {Game,Engine}/** are supported.',
    "- Bare | alternation is not supported. Use brace globs such as {A,B} instead.",
    '- Absolute patterns must stay inside the current workspaces.',
    '- To search recursively inside a folder, use a proper glob such as src/folder/**.',
    '',
    'Examples:',
    '- *.as: only .as files directly under the workspace root.',
    '- **/*.as: recursive .as files across the workspace.',
    '- *.{h,cpp}: only .h and .cpp files directly under the workspace root.',
    '- **/*.{h,cpp}: recursive .h and .cpp files across the workspace.',
    '- Engine/**/*.{h,cpp}: recursive .h and .cpp files only in the Engine workspace folder.',
    '- {Game,Engine}/**/*.{h,cpp}: recursive .h and .cpp files only in the selected workspace folders.',
    '',
    'Scope note:',
    '- This resource defines the shared includePattern syntax only. Query fields such as lm_findFiles.query and lm_qgrepSearchFiles.query are not covered here.',
  ].join('\n');
}
