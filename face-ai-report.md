# AI Preload Contract: lm-tools-bridge

## Section A: Preload Contract
- Project one-liner: expose VS Code LM tools as local MCP HTTP services with Manager-based workspace binding.
- Audience: AI agent performing code changes with minimal repo traversal.
- Version baseline: `1.0.94`.
- Must-read objective: preload this file, then jump to task-relevant entrypoints only.

### Hard Invariants
- Effective callable tools = exposed set intersection enabled set.
- `tools.unexposedDelta` overrides `tools.exposedDelta`.
- `tools.disabledDelta` overrides `tools.enabledDelta`.
- Built-in disabled tools must be pruned from all tool delta settings.
- `lm_getDiagnostics` uses `vscode.languages.getDiagnostics`.
- `lm_findFiles` and `lm_findTextInFiles` use VS Code workspace search backends (ripgrep-based file/text search).
- `lm_findFiles` and `lm_findTextInFiles` are default exposed but not default enabled.
- `lm_qgrepSearchText` always executes the bundled binary at `bin/qgrep.exe` and defaults to glob query mode; set `isRegexp=true` to switch query interpretation to regex.
- `lm_qgrepSearchText` uses smart-case when `caseSensitive` is false/omitted (all-lowercase queries are case-insensitive, and queries containing uppercase letters are case-sensitive); `caseSensitive=true` forces sensitive matching.
- In glob mode, both `lm_qgrepSearchText.query` and `lm_qgrepSearchFiles.query` follow VS Code glob semantics (`*`, `?`, `**`, `[]`, `[!...]`, `{a,b}`).
- In glob mode for `lm_qgrepSearchText.query`, `*` and `?` do not match `/`, while `**` can match across `/`; query matching remains substring-based (no implicit `^...$` anchoring).
- `lm_qgrepSearchFiles` accepts `query`/`isRegexp`/`maxResults`; default query semantics are VS Code-style glob and `isRegexp=true` switches to regex.
- In glob mode for `lm_qgrepSearchFiles.query`, patterns without `/` are treated as any-depth file globs (equivalent to `**/<pattern>`).
- `lm_qgrepSearchText` and `lm_qgrepSearchFiles` use default `maxResults=300` when input omits `maxResults`.
- `lm_qgrepSearchText` uses `maxResultsApplied` as the backend qgrep `search` call limit and clamps to `2000`; payload includes `maxResultsRequested` only when text input is clamped. `lm_qgrepSearchFiles` also clamps `maxResults` to `2000`, then forwards `maxResultsApplied` as the backend qgrep `files` call limit.
- `lm_qgrepSearchText` and `lm_qgrepSearchFiles` payload always includes `totalAvailable`; `totalAvailableCapped` is returned only when true and then `totalAvailable` is a lower bound; `hardLimitHit` is returned only when the backend query limit is hit.
- `lm_qgrepSearchText` payload includes `querySemanticsApplied`/`casePolicy`/`caseModeApplied`; `lm_qgrepSearchFiles` payload includes `querySemanticsApplied` and optional `scope`.
- qgrep text output parsing treats the first `:line:` delimiter as authoritative, so `preview` keeps literal `:number:` segments without corrupting path/line extraction.
- Custom tool `content.text` summaries are sanitized before returning: ANSI/control/bidi/zero-width characters are stripped for stable rendering; `structuredContent` payloads remain unchanged.
- `lm_qgrepSearchText` and `lm_qgrepSearchFiles` descriptions do not include the explicit "updating below 100% blocks until ready or 150s timeout" sentence and keep hard-limit wording concise; use `lm_qgrepGetStatus` for readiness details.
- On indexed workspaces, prefer `lm_qgrepSearchText`/`lm_qgrepSearchFiles` before ripgrep-based search tools for repeated searches because qgrep is typically much faster.
- `lm_qgrepGetStatus` returns qgrep binary/workspace/index progress status and does not require qgrep init; when no workspace index is initialized, payload also includes an auto-init hint that `lm_qgrepSearchText`/`lm_qgrepSearchFiles` will initialize on query.
- `lm_qgrepSearchText` and `lm_qgrepSearchFiles` are built-in required exposed tools and default enabled tools.
- qgrep auto-maintenance still depends on initialized workspaces (`<workspace>/.vscode/qgrep/workspace.cfg`), but `lm_qgrepSearchText`/`lm_qgrepSearchFiles` now auto-initialize all current workspaces on demand before searching.
- On extension startup, already-initialized qgrep workspaces auto-queue one background refresh that syncs extension-managed `workspace.cfg` blocks before running `qgrep update` for current-session progress/file totals.
- Startup refresh now includes one-shot auto-repair for corruption-like qgrep assertion failures: when update errors contain `Assertion failed` plus `filter.cpp`/`entries.entries`, the extension auto-attempts one per-workspace rebuild in the same startup session.
- `lm_qgrepSearchText`/`lm_qgrepSearchFiles` block tool completion until qgrep indexing is ready across current workspaces (including in-progress auto `qgrep update`) or timeout (150s).
- qgrep index operations (`init`/`update`/`build`) are serialized per workspace to avoid overlapping runs under parallel tool calls and auto-update activity.
- `Qgrep Rebuild Indexes` runs against all current workspaces; uninitialized workspaces are auto-initialized before rebuild.
- `Qgrep Stop And Clear Indexes` cancels in-flight qgrep index commands (`init`/`update`/`build`) before deleting `.vscode/qgrep` for all current workspaces, reducing clear-time qgrep `workspace.cfg` read errors.
- Status menu qgrep actions are dynamic: show `Qgrep Init All Workspaces` only when `initializedWorkspaces=0`; otherwise show only `Qgrep Rebuild Indexes` and `Qgrep Stop And Clear Indexes`.
- Status menu quick pick inserts a visual separator below qgrep actions before general actions (`Open Settings`, `Open Extension Page`).
- qgrep initialized `workspace.cfg` files include an extension-managed Unreal include block for `*.ush`/`*.usf`/`*.ini` plus an extension-managed PowerShell include block for `*.ps1`, and an extension-managed `search.exclude` block (`true` entries only) with fixed excludes for `.git`, `Intermediate`, `DerivedDataCache`, `Saved`, `.vs`, and `.vscode`; `.gitignore` is not synced.
- Generated qgrep regexes (both `workspace.cfg` sync rules and runtime `includePattern` glob filters) are validated to avoid non-capturing groups (`(?:...)`) and other Perl-style `(?...)` constructs because qgrep rejects that syntax.
- qgrep multi-root storage is per-workspace under `<workspace>/.vscode/qgrep`; `Qgrep Stop And Clear Indexes` removes that directory for all current workspaces and disables maintenance until re-init.
- qgrep runtime logs are written to a dedicated VS Code log channel `lm-tools-bridge-qgrep`; tooling debug logs use `lm-tools-bridge-tools`; server/manager logs remain in `lm-tools-bridge`.
- qgrep clear-cancel control flow logs (`... cancelled during clear`) are expected `info` entries and should not be treated as qgrep command failures.
- `lm_qgrepSearchText.includePattern` supports existing path scopes and glob scopes: non-glob paths must resolve to existing locations inside current workspace folders; glob scopes support workspace-relative patterns, `WorkspaceName/**` style workspace scoping, and absolute-path glob patterns (including Windows UNC path globs), and glob inputs are force-compiled into qgrep-compatible `fi` regex filters that run before qgrep output truncation.
- `lm_qgrepSearchText` uses `includePattern` for path/glob scope; legacy `searchPath` and `includeIgnoredFiles` inputs are ignored and do not affect query behavior.
- `lm_qgrepSearchFiles` rejects legacy `mode`/`searchPath` inputs; `includeIgnoredFiles` is tolerated but ignored.
- `lm_qgrepSearchFiles` supports regex workspace scoping via `WorkspaceName/<regex>` when `isRegexp=true`; the prefix is a literal scope selector and only the remainder is evaluated as regex.
- Status bar is split: server item (`LM Tools Bridge`) and dedicated qgrep item (`qgrep <circle> <percent> <A/B>`).
- qgrep status bar shows `qgrep not initialized` when there is no initialized workspace.
- qgrep tooltip reports binary readiness, aggregate file progress, and one per-workspace line in `A/B (percent)` format.
- Aggregate qgrep `A/B`/remaining uses file-weighted sum across initialized workspaces only when all initialized workspaces have known totals; otherwise show unknown (`--/--`) with optional sampled percent.
- `resolveInputFilePath` accepts absolute, `WorkspaceName/...`, and workspace-root relative paths; paths must exist, and multi-root relative inputs must resolve uniquely.
- `lmToolsBridge.requestWorkspaceMCPServer` on Windows accepts only normal absolute paths and `\\?\` + normal absolute paths with case-insensitive prefix matching; non-normal NT namespace forms are rejected.
- Successful `lmToolsBridge.requestWorkspaceMCPServer` payloads include `guidance.nextSteps` and `guidance.recoveryOnError` so clients can follow recovery hints from tool return values instead of relying only on static descriptions.
- Manager handshake/callTool descriptions remain concise; fallback and recovery guidance is primarily delivered via handshake return `guidance` and actionable JSON-RPC `error.message` text.
- Manager JSON-RPC error messages for stale session/workspace mismatch/offline-unreachable/direct-call input errors now include explicit `Next step:` guidance in `error.message` (no `error.data` change).
- Built-in `lm_*` path fields in `structuredContent` use absolute paths; `content.text` summaries prefer workspace-relative (`WorkspaceName/...`) display and fall back to absolute paths.
- `copilot_searchCodebase` placeholder output is treated as unavailable.

### Primary Entrypoints (Read First)
- `src/extension.ts -> activate | showStatusMenu | runQgrepInitAllCommand | runQgrepRebuildCommand | runQgrepStopAndClearIndexesCommand | getServerStatus | updateStatusBar | startMcpServer | handleMcpHttpRequest | getWorkspaceTooltipLines`
- `src/configuration.ts -> resolveActiveConfigTarget | getConfigScopeDescription`
- `src/tooling.ts -> configureExposureTools | configureEnabledTools | invokeExposedTool | runGetDiagnosticsTool | runQgrepGetStatusTool | runQgrepSearchTool | runQgrepFilesTool`
- `src/qgrep.ts -> activateQgrepService | runQgrepInitAllWorkspacesCommand | runQgrepRebuildIndexesCommand | runQgrepStopAndClearCommand | executeQgrepSearch | executeQgrepFilesSearch`
- `src/manager.ts -> handleMcpHttpRequest | dispatchRootsListRequest`
- `src/windowsWorkspacePath.ts -> isSupportedWindowsWorkspacePath | resolveComparablePath`

### Forbidden Assumptions
- Do not assume handshake can be skipped before tool calls.
- Do not assume User settings drive scope when `useWorkspaceSettings=true`.
- Do not assume forwarded LM tools always include both text and structured channels.
- Do not assume `/mcp/status` always returns JSON.

## Section B: Task Routing Cards
- [Server unavailable/port conflict] Read: `src/extension.ts -> startMcpServer`; Decide: `Off` => start, `Port In Use` => reconnect manager endpoint; Verify: `/mcp/health` ok and status bar `Running`.
- [Unknown Mcp-Session-Id] Read: `src/manager.ts -> handleMcpHttpRequest`; Decide: stale non-handshake session => re-bind via handshake; Verify: rerun `lmToolsBridge.requestWorkspaceMCPServer` then same tool call succeeds.
- [Actionable manager errors] Read: `src/manager.ts -> getWorkspaceNotMatchedMessage | getWorkspaceNotSetMessage | getUnknownSessionMessage | getManagerUnreachableMessage | getMcpOfflineMessage`; Decide: follow `error.message` `Next step:` guidance before shell fallback; Verify: stale-session/unmatched/offline/invalid-direct-call responses all include a concrete recovery step.
- [Handshake guidance output] Read: `src/manager.ts -> buildHandshakeGuidance | handleRequestWorkspace | formatWorkspaceHandshakeSummary`; Decide: consume `guidance.nextSteps` / `guidance.recoveryOnError` from handshake tool return before fallback; Verify: handshake summary text and structured payload both include guidance fields.
- [Workspace handshake path rejected] Read: `src/manager.ts -> isSupportedWindowsWorkspacePath | stripWindowsNtNamespacePrefix | handleRequestWorkspace`; Decide: on Windows allow only normal absolute paths and `\\?\` + normal absolute paths; Verify: non-normal NT namespace formats fail with params error while normal and prefixed-normal forms bind the same workspace target.
- [Tool not found or disabled] Read: `src/tooling.ts -> getEnabledExposedToolsSnapshot | invokeExposedTool`; Decide: exposure first, enabled second; Verify: target appears in effective set and call succeeds.
- [Tool selection config mismatch] Read: `src/tooling.ts -> setExposedTools | setEnabledTools | pruneBuiltInDisabledFromDeltas | pruneEnabledDeltasByExposed`; Decide: required/built-in-disabled/exposed-first rules apply; Verify: deltas normalize and intended tool state persists.
- [Config scope mismatch] Read: `src/configuration.ts -> resolveActiveConfigTarget | getConfigScopeDescription`; Decide: evaluate `useWorkspaceSettings` + `.code-workspace`; Verify: tooltip line `Config scope: ...` matches expectation.
- [Diagnostics validation/truncation] Read: `src/tooling.ts -> runGetDiagnosticsTool`; Decide: validate `filePaths` resolution (absolute/`WorkspaceName/...`/relative + unique existing match), `maxResults`, and `severities` before suspecting data loss; Verify: payload contains `scope/files/preview` and expected counts after retry.
- [qgrep init/watch lifecycle] Read: `src/qgrep.ts -> initAllWorkspaces | rebuildAllWorkspaces | startWatchForInitializedWorkspaces | startAutoUpdateWatchersForInitializedWorkspaces | stopAndClearAllWorkspaces | updateWorkspaceProgress | search | files`; Decide: manual init command still works, rebuild/clear menu commands now iterate all current workspaces, qgrep search/files auto-init all workspaces and block until indexing/update readiness, startup refresh for initialized workspaces syncs extension-managed `workspace.cfg` blocks before `qgrep update` and one-shot auto-rebuilds when corruption-like assertion signatures are detected, qgrep `watch` covers existing-file content changes, create/delete events trigger debounced `qgrep update`, `search.exclude=true` rules sync into managed `workspace.cfg` excludes (plus fixed `.git` exclude), and clear command disables by deleting `.vscode/qgrep`; Verify: `workspace.cfg` presence controls watch/auto-update startup and tool calls wait during indexing before returning results.
- [qgrep status inspection] Read: `src/qgrep.ts -> getQgrepStatusSummary`; Decide: use `lm_qgrepGetStatus` before qgrep search tools or after search/files wait/timeout to inspect binary readiness/init/progress; Verify: payload includes `binaryAvailable`, `workspaceStatuses`, and aggregate progress summary.
- [qgrep search scope rejected] Read: `src/qgrep.ts -> resolveIncludePattern | resolveGlobSearchTargets | ensureFilesLegacyParamsUnsupported`; Decide: `lm_qgrepSearchText.includePattern` enforces existing path/glob rules while legacy `searchPath`/`includeIgnoredFiles` are ignored on text search; `lm_qgrepSearchFiles` rejects legacy `mode`/`searchPath`; Verify: text outside/ambiguous includePattern returns expected tool error, text `searchPath`/`includeIgnoredFiles` do not change behavior, and files legacy params return unsupported errors.
- [copilot_searchCodebase placeholder] Read: `src/tooling.ts -> isCopilotSearchCodebasePlaceholderResponse`; Decide: placeholder means unavailable by policy; Verify: error payload returned and fallback tools used.
- [Roots sync not triggered] Read: `src/manager.ts -> dispatchRootsListRequest`; Decide: requires client roots capability + trigger events; Verify: logs contain `roots.list.request/result/error/skip/timeout`.

## Section C: Change Impact Map
- Doc defaults: code changes -> `face-ai-report.md`; `README.md` only if user-facing; `CHANGELOG.md` on version bump.
- Config scope -> `src/configuration.ts`, `src/extension.ts`.
- Exposure/enable policy -> `src/tooling.ts`.
- qgrep tool schema/default exposure -> `src/tooling.ts`.
- qgrep glob compiler/shared semantics -> `src/qgrepGlob.ts`.
- qgrep index lifecycle/commands/search backend/status snapshot -> `src/qgrep.ts`, `src/extension.ts`.
- Handshake/session routing -> `src/manager.ts`.
- Diagnostics contract -> `src/tooling.ts`.
- Server/qgrep status bar and tooltip behavior -> `src/extension.ts`.
- Version bump only -> `CHANGELOG.md`.

## Section D: Verification Checklist
- Package: run `npx @vscode/vsce package --out lm-tools-bridge-latest.vsix` (overwrites the previous VSIX only on success).
- Tests: run `npm test` to verify Windows workspace path acceptance/comparable-path normalization and qgrep glob semantics (`text` + `files`).
- Happy-path: verify one handshake + one tool call + one diagnostics call + one qgrep status call + one qgrep search call + one qgrep files call.
- Handshake-path: on Windows verify `lmToolsBridge.requestWorkspaceMCPServer` succeeds for both normal and prefixed-normal `cwd` forms against the same workspace, and rejects non-normal NT namespace formats.
- Failure-path: verify one expected failure (`Tool not found or disabled` or stale session).
- Manager-errors: verify `Unknown Mcp-Session-Id`, `workspace not set/matched`, `Manager unreachable`, `Resolved MCP server is offline`, and direct-call invalid params all include actionable `Next step:` text.
- qgrep-path: verify `Qgrep Init All Workspaces` => edit existing file (watch path) and create/delete file (auto `update` path) => `lm_qgrepSearchText` sees expected changes without manual rebuild.
- qgrep-config-sync: verify `search.exclude` (true entries) change rewrites managed `workspace.cfg` block and triggers qgrep `update`; confirm fixed excludes (`.git`, `Intermediate`, `DerivedDataCache`, `Saved`, `.vs`, `.vscode`) are always present.
- qgrep-status-ui: verify server status and qgrep status render as separate status bar items, and qgrep tooltip shows per-workspace `A/B` lines.
- qgrep-failure: verify `lm_qgrepSearchText` outside-workspace `includePattern` returns expected error, legacy `searchPath`/`includeIgnoredFiles` on text search are ignored, `lm_qgrepSearchFiles` rejects legacy `mode`/`searchPath` while ignoring `includeIgnoredFiles`, and no-init qgrep search/files auto-initialize then wait for readiness instead of failing immediately.
- qgrep-startup-repair: verify startup auto-update assertion signature (`Assertion failed` + `filter.cpp`/`entries.entries`) triggers one rebuild attempt per workspace per startup, and non-signature update failures do not trigger rebuild.
- Docs: verify update triggers against `AGENTS.md`.

## Section E: Historical or Unreachable Appendix
- Historical notes stay in appendix only and must not be described as current runtime mainline.
