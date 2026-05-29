# Tools And Configuration

## Tool Exposure And Selection
- Effective callable tools are the exposed set intersected with the enabled set.
- Built-in disabled tools are pruned from all deltas.
- `lm_findFiles` and `lm_findTextInFiles` use VS Code workspace search backends and are default exposed but not default enabled.
- `lm_findFiles.query` always uses glob semantics and rejects bare `|` alternation with guidance to use brace globs.
- `lm_findTextInFiles` defaults to `querySyntax='literal'`, supports `querySyntax='regex'`, and rejects legacy `isRegexp`.
- `lm_copilot_searchCodebase` placeholder output is treated as unavailable; runtime invocation still calls the original source tool.

## Configuration Scope
- Extension-managed `lmToolsBridge.*` settings use resource scope.
- `useWorkspaceSettings=false` keeps writes at Global scope.
- `.code-workspace` sessions write at Workspace scope.
- Single-folder workspaces write panel changes to `.vscode/settings.json` when workspace settings are enabled.
- Single-folder reads keep the WorkspaceFolder -> Workspace fallback.

## pathScope And Diagnostics
- `pathScope` parameters include a compact syntax summary in their description; the full shared syntax remains in `lm-tools://guide`.
- Accepted forms include workspace-relative patterns, `WorkspaceName/...`, brace-selected workspace groups, full-branch brace globs, and absolute paths/globs inside current workspaces.
- Bare `|` alternation is rejected in favor of brace globs.
- `lm_getDiagnostics.pathScope` is optional, uses the shared syntax without schema `pattern`/`minLength` constraints, returns `scope` as `workspace+external` or `filtered`, and filtered mode ignores non-workspace/non-file diagnostics.
- Custom `lm_` tool schemas use object-level `required` arrays to distinguish required from optional parameters; `pathScope` fields do not use schema `pattern`/`minLength` to express requiredness.

## Formatting
- `lm_formatFiles` is default exposed but not default enabled.
- It requires `pathScope`, formats matched workspace files through `editor.action.formatDocument`, and honors active language-scoped formatter selection.
- It best-effort restores the previously active editor, saves only changed files, reports skipped/failure details, and treats unchanged text as `unchanged`.
