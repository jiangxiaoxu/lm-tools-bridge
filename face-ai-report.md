# AI Preload Contract: lm-tools-bridge

## Section A: Preload Contract
- Project one-liner: expose VS Code LM tools as local MCP HTTP services with Manager-based workspace binding.
- Audience: AI agent performing code changes with minimal repo traversal.
- Version baseline: `1.0.91`.
- Current build constraint: `lm_clangd_*` tools are hard-disabled and not registered.
- Must-read objective: preload this file, then jump to task-relevant entrypoints only.

### Hard Invariants
- Effective callable tools = exposed set intersection enabled set.
- `tools.unexposedDelta` overrides `tools.exposedDelta`.
- `tools.disabledDelta` overrides `tools.enabledDelta`.
- Built-in disabled tools must be pruned from all tool delta settings.
- `lm_getDiagnostics` uses `vscode.languages.getDiagnostics`.
- Built-in `lm_*` path fields in `structuredContent` use absolute paths; `content.text` summaries prefer workspace-relative (`WorkspaceName/...`) display and fall back to absolute paths.
- `copilot_searchCodebase` placeholder output is treated as unavailable.
- `lm_clangd_*` tools remain disabled in current build.

### Primary Entrypoints (Read First)
- `src/extension.ts -> activate | startMcpServer | handleMcpHttpRequest | getWorkspaceTooltipLines`
- `src/configuration.ts -> resolveActiveConfigTarget | getConfigScopeDescription`
- `src/tooling.ts -> configureExposureTools | configureEnabledTools | invokeExposedTool | runGetDiagnosticsTool`
- `src/manager.ts -> handleMcpHttpRequest | dispatchRootsListRequest`

### Forbidden Assumptions
- Do not assume handshake can be skipped before tool calls.
- Do not assume User settings drive scope when `useWorkspaceSettings=true`.
- Do not assume forwarded LM tools always include both text and structured channels.
- Do not assume `/mcp/status` always returns JSON.

## Section B: Task Routing Cards
- [Server unavailable/port conflict] Read: `src/extension.ts -> startMcpServer`; Decide: `Off` => start, `Port In Use` => reconnect manager endpoint; Verify: `/mcp/health` ok and status bar `Running`.
- [Unknown Mcp-Session-Id] Read: `src/manager.ts -> handleMcpHttpRequest`; Decide: stale non-handshake session => re-bind via handshake; Verify: rerun `lmToolsBridge.requestWorkspaceMCPServer` then same tool call succeeds.
- [Tool not found or disabled] Read: `src/tooling.ts -> getEnabledExposedToolsSnapshot | invokeExposedTool`; Decide: exposure first, enabled second; Verify: target appears in effective set and call succeeds.
- [Tool selection config mismatch] Read: `src/tooling.ts -> setExposedTools | setEnabledTools | pruneBuiltInDisabledFromDeltas | pruneEnabledDeltasByExposed`; Decide: required/built-in-disabled/exposed-first rules apply; Verify: deltas normalize and intended tool state persists.
- [Config scope mismatch] Read: `src/configuration.ts -> resolveActiveConfigTarget | getConfigScopeDescription`; Decide: evaluate `useWorkspaceSettings` + `.code-workspace`; Verify: tooltip line `Config scope: ...` matches expectation.
- [Diagnostics validation/truncation] Read: `src/tooling.ts -> runGetDiagnosticsTool`; Decide: validate `maxResults`/`severities` and inspect `capped` before suspecting data loss; Verify: payload contains `scope/files/preview` and expected counts after retry.
- [copilot_searchCodebase placeholder] Read: `src/tooling.ts -> isCopilotSearchCodebasePlaceholderResponse`; Decide: placeholder means unavailable by policy; Verify: error payload returned and fallback tools used.
- [Roots sync not triggered] Read: `src/manager.ts -> dispatchRootsListRequest`; Decide: requires client roots capability + trigger events; Verify: logs contain `roots.list.request/result/error/skip/timeout`.

## Section C: Change Impact Map
- Doc defaults: code changes -> `face-ai-report.md`; `README.md` only if user-facing; `CHANGELOG.md` on version bump.
- Config scope -> `src/configuration.ts`, `src/extension.ts`.
- Exposure/enable policy -> `src/tooling.ts`.
- Handshake/session routing -> `src/manager.ts`.
- Diagnostics contract -> `src/tooling.ts`.
- Status tooltip behavior -> `src/extension.ts`.
- Version bump only -> `CHANGELOG.md`.

## Section D: Verification Checklist
- Compile: run `npm run compile`.
- Happy-path: verify one handshake + one tool call + one diagnostics call.
- Failure-path: verify one expected failure (`Tool not found or disabled` or stale session).
- Docs: verify update triggers against `AGENTS.md`.

## Section E: Historical or Unreachable Appendix
- Clangd snapshot is empty in current build and legacy `lm_clangd_*` symbols are not registered.
- Clangd startup/request chains (`ensureClangdRunning`, `sendRequestWithAutoStart`, related path resolvers) are historical and unreachable from exposed tools.
- Historical notes stay in appendix only and must not be described as current runtime mainline.
