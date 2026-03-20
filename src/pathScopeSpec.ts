export const PATH_SCOPE_SPEC_URI = 'lm-tools://spec/pathScope';
export const PATH_SCOPE_SHARED_SYNTAX_ID = 'lm-tools-bridge/pathScope/v1';
const PATH_SCOPE_SHARED_SYNTAX_KIND = 'workspace-path-or-glob-scope';

export function getPathScopeFieldDescription(): string {
  return `Optional workspace path or glob scope. Supports <glob>, WorkspaceName/<glob>, brace workspace selectors, and absolute patterns inside current workspaces. Read ${PATH_SCOPE_SPEC_URI} for examples and invalid forms.`;
}

export function getPathScopeToolDescriptionSentence(): string {
  return `pathScope uses the shared ${PATH_SCOPE_SPEC_URI} syntax.`;
}

export function getPathScopeSpecResourceDescription(): string {
  return 'Read the shared pathScope syntax used by workspace search and diagnostics tools.';
}

export function getPathScopeSpecReadHint(): string {
  return `Before using any tool argument named pathScope, you must read ${PATH_SCOPE_SPEC_URI} first.`;
}

export function buildPathScopeSchema(options?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'string',
    description: getPathScopeFieldDescription(),
    'x-lm-tools-bridge-sharedSyntax': {
      id: PATH_SCOPE_SHARED_SYNTAX_ID,
      uri: PATH_SCOPE_SPEC_URI,
      kind: PATH_SCOPE_SHARED_SYNTAX_KIND,
    },
    ...(options ?? {}),
  };
}

export function getPathScopeSpecText(): string {
  return [
    'Shared pathScope syntax',
    '',
    'Applies to:',
    '- lm_findTextInFiles.pathScope',
    '- lm_qgrepSearchText.pathScope',
    '- lm_getDiagnostics.pathScope',
    '',
    'What it is:',
    '- Limit workspace file paths before text search or diagnostics filtering is applied.',
    '',
    'Accepted forms:',
    '- <glob>',
    '- GameWorkspace/<glob>',
    '- {GameWorkspace,UE5}/<glob>',
    '- {GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}',
    '- absolute path/glob inside current workspaces',
    '',
    'Important rules:',
    '- Use VS Code glob semantics.',
    '- `*` is not recursive; `**` is recursive.',
    '- Use brace globs, not bare `|` alternation.',
    '- In mixed top-level brace branches, unscoped branches apply to all current workspaces.',
    '- Absolute patterns must stay inside current workspaces.',
    '',
    'Common examples:',
    '- Script/**/*.as',
    '- GameWorkspace/Script/**/*.as',
    '- {GameWorkspace,UE5}/**/*.{h,cpp,as}',
    '- {GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h}',
    '',
    'Mixed example:',
    '- In `{GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}`, the first two branches are scoped, while the last two are unscoped.',
    '- `Config/**/*.ini` matches from each workspace root, while `**/Source/**/*.{h,cpp}` can also match deeper nested `Source` trees.',
    '',
    'Invalid or misleading examples:',
    '- GameWorkspace|UE5/**/*.as: invalid. Use brace globs such as {GameWorkspace,UE5}/**/*.as.',
    '- GameWorkspace/*/*.as: valid, but not recursive. If you meant recursive matching, use GameWorkspace/**/*.as.',
    '',
    'Scope note:',
    '- This spec applies only to `pathScope`, not file-search `query` fields.',
  ].join('\n');
}
