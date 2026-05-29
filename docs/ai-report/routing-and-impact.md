# Routing And Impact Map

## Task Routing Cards
- Server unavailable/port conflict -> read `src/extension.ts`; verify `/mcp/health`, discovery pipe publication, and status bar.
- Actionable stdio manager errors -> read `src/stdioManager.ts`; verify unmatched/offline/invalid-direct-call responses include concrete `Next step:` text.
- Handshake guidance output -> read `src/stdioManagerRuntime.ts`, `src/toolDefinitionsContract.ts`, and `src/managerHandshake.ts`; verify guidance, ToolDefinition schemas, and omitted redundant fields.
- Workspace handshake path rejected -> read `src/stdioManager.ts` and `src/windowsWorkspacePath.ts`; verify Windows path acceptance/rejection.
- Handshake auto-start or wrong launch target -> read `src/stdioManager.ts`; verify marker priority and `code.cmd`/`code` probing.
- Tool not found or disabled -> read `src/tooling.ts`; verify exposure first, enabled second.
- Tool selection config mismatch -> read `src/tooling.ts`; verify required, built-in-disabled, and exposed-first rules.
- Config scope mismatch -> read `src/configuration.ts`; verify `useWorkspaceSettings` plus workspace-file/single-folder scope.
- Workspace config panel writes fail or go missing -> read `package.json`, `src/configuration.ts`, and `src/tooling.ts`; verify write target and surfaced scope-aware failures.
- Diagnostics validation/truncation -> read `src/tooling.ts` and `src/diagnosticsPathScope.ts`; verify pathScope parsing, maxResults, severities, and filtered diagnostics.
- qgrep init/watch lifecycle -> read `src/qgrep.ts`; verify auto-init, readiness gate, managed config sync, recovery, watch/update, and clear behavior.
- qgrep watch appears stuck -> read `src/qgrep.ts`; verify stale partial progress restart then rebuild escalation.
- qgrep status inspection -> read `src/qgrep.ts`; verify binary, workspace counts, aggregate progress, and per-workspace lines.
- qgrep search scope rejected -> read `src/qgrep.ts`, `src/qgrepTextQuery.ts`, and `src/qgrepFilesQuery.ts`; verify pathScope, literal pipe parsing, and legacy param rejection.
- `lm_` tool-name normalization -> read `src/toolNameNormalization.ts` and `src/tooling.ts`; verify exposed/source names and config migration.
- `lm_copilot_searchCodebase` placeholder -> read `src/tooling.ts`; verify placeholder unavailable policy.
- Discovery pipe missing or untitled multi-root -> read `src/workspaceDiscovery.ts` and `src/stdioManager.ts`; verify deterministic discovery and saved workspace requirement.

## Change Impact Map
- Documentation defaults -> `docs/index.md` and relevant `docs/ai-report/*`.
- User-facing behavior docs -> `README.md`.
- Version bump -> `package.json`, `package-lock.json`, and `CHANGELOG.md`.
- Config scope -> `src/configuration.ts`, `src/extension.ts`.
- Workspace config panel writes -> `package.json`, `src/configuration.ts`, `src/tooling.ts`, and settings-write tests.
- Stdio manager packaging/filtering -> `scripts/bundle.mjs`, `.vscodeignore`.
- Stdio manager stable publication -> `src/stdioManagerSync.ts`, `src/extension.ts`, `scripts/bundle.mjs`.
- Legacy manager cleanup -> `src/legacyManagerCleanup.ts`, `src/extension.ts`.
- Startup dependency prompting -> `src/runtimeDependencyCheck.ts`, `src/extension.ts`, runtime dependency tests.
- Exposure/enable policy -> `src/tooling.ts`.
- qgrep schema/default exposure -> `src/tooling.ts`.
- qgrep workspace scope -> `src/qgrepWorkspaceScope.ts`.
- qgrep glob compiler/shared semantics -> `src/qgrepGlob.ts`.
- qgrep literal text parsing -> `src/qgrepTextQuery.ts`.
- qgrep files query parsing -> `src/qgrepFilesQuery.ts`.
- Shared search input parsing -> `src/searchInput.ts`.
- qgrep output formatting -> `src/qgrepOutput.ts`, `src/tooling.ts`.
- qgrep index lifecycle/search/status -> `src/qgrep.ts`, `src/extension.ts`.
- Handshake/session routing -> `src/stdioManager.ts`, `src/workspaceDiscovery.ts`, `src/managerHandshake.ts`.
- Diagnostics contract -> `src/tooling.ts`, `src/diagnosticsPathScope.ts`.
- Format tool and pathScope enumeration -> `src/tooling.ts`, `src/pathScope.ts`, `src/pathScopeSpec.ts`.
- Integration runner/fixtures -> `src/test/integration/*`, `src/test/manager-integration/*`, fixture directories.
