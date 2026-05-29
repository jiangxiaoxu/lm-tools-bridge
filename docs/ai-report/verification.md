# Verification

## Command Selection
- Package verification: `npx @vscode/vsce package --out lm-tools-bridge-latest.vsix`.
- Unit tests: `npm run test:unit`.
- VS Code integration tests on Windows: `npm run test:integration`.
- Real stdio-manager auto-start integration on Windows: `npm run test:manager-integration`.
- Combined default path: `npm run test:all`.

## Baseline Scenarios
- Startup dependency: missing `node`, missing `winget`, warning-once, installer launch failure, and browser open failure through injected doubles only.
- Stable manager publication: synced artifacts, metadata, publish lock serialization, live manager notification, lazy generation refresh, version-only generation stability, and reload failure recovery.
- Legacy cleanup: `%LOCALAPPDATA%\\lm-tools-bridge\\instances` removal is best-effort and non-blocking.
- Happy path: bind, cached/missing-only ToolDefinition lookup, dynamic `tools/list`, bridged direct call, diagnostics, qgrep status, qgrep text search, and qgrep file search.
- Handshake path: normal and prefixed-normal Windows paths bind the same target, non-normal NT namespace paths fail, and auto-start happens only during handshake.
- Failure path: verify at least one expected tool-not-found/disabled or post-handshake offline failure.
- Stdio manager errors: workspace not set/matched, unreachable, offline, and invalid direct-call params include actionable `Next step:` text.
- Concurrency: multiple stdio manager processes can bind the same or different workspaces without leaking tool state.

## qgrep Scenarios
- Watch path: init all workspaces, edit existing file, create/delete file, and verify qgrep sees changes without manual rebuild.
- Config sync: `search.exclude=true` changes rewrite managed `workspace.cfg` and trigger update; fixed excludes remain present.
- Status UI: server and qgrep status bar items remain separate; qgrep tooltip shows per-workspace `A/B` lines.
- Failure/query parsing: outside-workspace pathScope, literal pipe behavior, malformed quotes, escaped pipes, empty-branch fallback, rejected text glob syntax, rejected file bare pipe, rejected legacy params, no-init auto-init, readiness completion without final `100%`, and consistent file-search caps.
- Startup repair: corruption-like assertion signatures trigger one rebuild attempt per workspace per startup; non-signature failures do not.

## Tool And Config Scenarios
- `lm_formatFiles`: requires pathScope, rejects outside-workspace scopes, respects excludes, formats through VS Code editor command path, restores active editor, saves only changed files, and returns readable text.
- Workspace config writes: workspace settings write to `.vscode/settings.json` for single-folder workspaces and `.code-workspace` for workspace-file sessions; Global writes remain Global when disabled.
- Docs: documentation routing and maintenance rules should match `AGENTS.md`.

