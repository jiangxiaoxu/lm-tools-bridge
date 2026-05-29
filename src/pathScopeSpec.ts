const PATH_SCOPE_FIELD_DESCRIPTION = [
  'Optional workspace path or glob scope.',
  'Applies only to arguments named pathScope.',
  'Accepted forms include workspace-relative globs such as src/**/*.ts, workspace-scoped globs such as WorkspaceA/src/**, brace workspace scopes such as {WorkspaceA,UE5}/**/*.{ts,tsx}, and absolute paths or globs inside current workspaces.',
  'Use VS Code glob semantics with bridge rules: ** is recursive, * is not recursive, use brace globs instead of bare | alternation, and absolute patterns outside current workspaces are rejected.',
  'Full syntax is available in lm-tools://guide.',
].join(' ');

export function getPathScopeFieldDescription(): string {
  return PATH_SCOPE_FIELD_DESCRIPTION;
}

export function getPathScopeToolDescriptionSentence(): string {
  return 'pathScope includes a compact syntax summary in its parameter description; full syntax is available in lm-tools://guide.';
}

export function buildPathScopeSchema(options?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'string',
    description: getPathScopeFieldDescription(),
    ...(options ?? {}),
  };
}

export function getPathScopeSpecText(): string {
  return [
    'Shared pathScope syntax',
    '',
    'Applies to any tool argument named `pathScope`.',
    '',
    'What it is:',
    '- Limit workspace file paths before text search or diagnostics filtering is applied.',
    '',
    'Accepted forms:',
    '- <glob>',
    '- WorkspaceA/<glob>',
    '- {WorkspaceA,UE5}/<glob>',
    '- {WorkspaceA/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}',
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
    '- WorkspaceA/Script/**/*.as',
    '- {WorkspaceA,UE5}/**/*.{h,cpp,as}',
    '- {WorkspaceA/Script/Foo.as,WorkspaceA/Script/Bar.as}',
    '- {WorkspaceA/Script/**/*.as,UE5/Engine/**/Source/**/*.h}',
    '',
    'Mixed example:',
    '- In `{WorkspaceA/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}`, the first two branches are scoped, while the last two are unscoped.',
    '- `Config/**/*.ini` matches from each workspace root, while `**/Source/**/*.{h,cpp}` can also match deeper nested `Source` trees.',
    '',
    'Invalid or misleading examples:',
    '- WorkspaceA|UE5/**/*.as: invalid. Use brace globs such as {WorkspaceA,UE5}/**/*.as.',
    '- MovieSceneTracks/**/*.{h,cpp}|MovieSceneTools/**/*.cpp: invalid. When you need OR across multiple full path/glob branches, wrap the branches in one top-level brace expression instead.',
    '- Use {MovieSceneTracks/**/*.{h,cpp},MovieSceneTools/**/*.cpp} instead of the bare `|` form above.',
    '- WorkspaceA/*/*.as: valid, but not recursive. If you meant recursive matching, use WorkspaceA/**/*.as.',
    '',
    'Scope note:',
    '- This spec applies only to `pathScope`, not file-search `query` fields.',
  ].join('\n');
}
