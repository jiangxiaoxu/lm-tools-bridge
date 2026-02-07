# LM Tools Bridge

LM Tools Bridge is a VS Code extension that exposes the VS Code Language Model API as a local MCP HTTP service and adds a Manager to automate workspace handshakes and tool forwarding.

## Branches and Versions

- release branch: legacy implementation without the Manager. You must manually switch the control port and handle target selection yourself.
- beta/current branch: includes the Manager for automatic port allocation, workspace handshakes, tool forwarding, and health checks.

If you are on the release branch, consider moving to the Manager-enabled version to avoid manual control port switching.

## Quick Start

1. Open the extension in VS Code.
2. Run `npm install`.
3. Press `F5` to launch the Extension Development Host.
4. Click the status bar entry and use the status menu or `Dump Enabled Tools`.
5. Open Output -> `LM Tools Bridge` for logs.

## MCP Server and Manager

The extension starts a local MCP Streamable HTTP server and uses the Manager to coordinate multi-workspace targets.

- MCP server: `http://127.0.0.1:48123/mcp`
- Manager status: `http://127.0.0.1:47100/mcp/status`

### Typical call flow

1. Run the Manager handshake: `lmToolsBridge.requestWorkspaceMCPServer`.
2. Fetch tool names or schema: `lm-tools://names` or `lm-tools://schema/{name}`.
3. Call `tools/call` on the target, or use the Manager bridge tool when needed.

### Manager bridge tool

If your client does not support `tools/call`, use the Manager bridge tool after the handshake succeeds:

- Tool name: `lmToolsBridge.callTool`

Input example:

```json
{
  "name": "lm_findFiles",
  "arguments": {
    "query": "src/**/*.ts",
    "maxResults": 20
  }
}
```

## Default enabled tools

Default enabled tools are defined by `DEFAULT_ENABLED_TOOL_NAMES`:

- `copilot_searchCodebase`
- `copilot_searchWorkspaceSymbols`
- `copilot_listCodeUsages`
- `lm_findFiles`
- `lm_findTextInFiles`
- `lm_clangd_status` (only when `lmToolsBridge.clangd.enabled=true`)
- `lm_clangd_switchSourceHeader` (only when `lmToolsBridge.clangd.enabled=true`)
- `lm_clangd_ast` (only when `lmToolsBridge.clangd.enabled=true`)
- `lm_clangd_typeHierarchy` (only when `lmToolsBridge.clangd.enabled=true`)
- `lm_clangd_typeHierarchyResolve` (only when `lmToolsBridge.clangd.enabled=true`)
- `lm_clangd_lspRequest` (only when `lmToolsBridge.clangd.enabled=true` and `lmToolsBridge.clangd.enablePassthrough=true`)
- `copilot_getErrors`
- `copilot_readProjectStructure`

## Default exposed tools

Default exposed tools use the same baseline as `DEFAULT_ENABLED_TOOL_NAMES`.

Any tool outside that default list is unexposed by default, but can be manually exposed in `Configure Exposure Tools`.

## Built-in disabled tools

These tools are always blocked. They cannot be exposed or enabled.

- `copilot_applyPatch`
- `copilot_insertEdit`
- `copilot_replaceString`
- `copilot_multiReplaceString`
- `copilot_createFile`
- `copilot_createDirectory`
- `copilot_createNewJupyterNotebook`
- `copilot_editNotebook`
- `copilot_runNotebookCell`
- `copilot_readFile`
- `copilot_createNewWorkspace`
- `copilot_getVSCodeAPI`
- `copilot_installExtension`
- `copilot_runVscodeCommand`
- `create_and_run_task`
- `run_in_terminal`
- `manage_todo_list`
- `copilot_memory`
- `copilot_getNotebookSummary`
- `copilot_fetchWebPage`
- `copilot_openSimpleBrowser`
- `copilot_editFiles`
- `copilot_getProjectSetupInfo`
- `copilot_getDocInfo`
- `copilot_askQuestions`
- `copilot_readNotebookCellOutput`
- `copilot_switchAgent`
- `copilot_toolReplay`
- `copilot_listDirectory`
- `search_subagent`
- `runSubagent`
- `vscode_get_confirmation`
- `vscode_get_terminal_confirmation`
- `inline_chat_exit`
- `copilot_githubRepo`

## Settings

- `lmToolsBridge.server.autoStart` (default: true)
- `lmToolsBridge.server.port` (default: 48123)
- `lmToolsBridge.manager.httpPort` (default: 47100)
- `lmToolsBridge.useWorkspaceSettings` (default: false; only honored in workspace settings)
- `lmToolsBridge.clangd.enabled` (default: false; gates all `lm_clangd_*` tools)
- `lmToolsBridge.clangd.autoStartOnInvoke` (default: true; invokes `clangd.activate` when clangd is not running)
- `lmToolsBridge.clangd.enablePassthrough` (default: true; controls `lm_clangd_lspRequest`)
- `lmToolsBridge.clangd.requestTimeoutMs` (default: 10000)
- `lmToolsBridge.clangd.allowedMethods` (default: `[]`; empty falls back to built-in read-only allowlist)
- `lmToolsBridge.tools.exposedDelta` (default: `[]`; additional exposes relative to defaults)
- `lmToolsBridge.tools.unexposedDelta` (default: `[]`; additional unexposes relative to defaults; takes precedence over `tools.exposedDelta`)
- `lmToolsBridge.tools.enabledDelta` (default: `[]`; additional enables relative to defaults)
- `lmToolsBridge.tools.disabledDelta` (default: `[]`; additional disables relative to defaults)
- `lmToolsBridge.tools.groupingRules` (default: AngelScript + Clangd rules; regex-based custom grouping rules by tool name; each rule uses `{ id, label, pattern, flags? }`)
- `lmToolsBridge.tools.enabled` has been removed. Use `tools.enabledDelta` / `tools.disabledDelta` instead.
- `lmToolsBridge.tools.schemaDefaults` (defaults defined in extension configuration)
- `lmToolsBridge.tools.responseFormat` (default: `text`; `text` | `structured` | `both`)
- `lmToolsBridge.debug` (default: `off`; `off` | `simple` | `detail`)

## Tool configuration UI

The configuration commands now open a tree-based webview panel grouped by tool source:

- `custom rules`: top-level groups generated from `lmToolsBridge.tools.groupingRules` in configured order
- `custom`: tools implemented by this extension (`isCustom===true`)
- `copilot`: tools with the `copilot_` prefix
- `vscode`: standard `vscode.lm.tools` entries
- `other`: fallback group for uncategorized entries
- `Built-in Disabled` (parent group): hard-blocked tools shown at the bottom with child groups from `groupingRules` first, then `Copilot|VS Code|Custom|Other`

Supported interactions in both pages:

- `Configure Exposure Tools` (`lm-tools-bridge.configureExposure`)
- `Configure Enabled Tools` (`lm-tools-bridge.configureEnabled`)
- Group collapse/expand
- Group-level batch check/uncheck
- Search by name/description/tags
- `Reset` / `Confirm` / `Cancel`
- Real-time selected item count

Selection model:

- `Exposure`: defines which tools are available for enablement.
- `Enabled`: only applies within the currently exposed set.
- Effective MCP tool set = `exposed` intersection `enabled`.
- Grouping priority is `built-in disabled > groupingRules (first match wins) > built-in groups`.
- When a tool becomes unexposed, its `enabledDelta` / `disabledDelta` entries are automatically pruned.
- Built-in disabled tools are moved into the bottom parent group (`Built-in Disabled`) with source child groups and are always read-only.
- Built-in disabled tools are never shown in the enabled panel.
- Built-in disabled tools are automatically removed from `exposedDelta` / `unexposedDelta` / `enabledDelta` / `disabledDelta` during normalization.
- Tools in the built-in default-enabled list are always exposed unless the same tool is listed as built-in disabled.

If webview initialization fails, the extension automatically falls back to the legacy QuickPick flow.

## lm_findFiles

- `query`: glob pattern
- `maxResults`: number, default 200
- `includeIgnoredFiles`: boolean; when true, ignore `.gitignore` / `files.exclude` / `search.exclude`

## lm_findTextInFiles

- `query`: string
- `isRegexp`: boolean
- `caseSensitive`: boolean
- `includePattern`: glob
- `maxResults`: number, default 500
- `includeIgnoredFiles`: boolean

## clangd MCP tools

These tools are available only when `lmToolsBridge.clangd.enabled=true`.

- `lm_clangd_status`: report clangd extension/client availability, trust state, and effective settings.
- `lm_clangd_switchSourceHeader`: call `textDocument/switchSourceHeader`.
- `lm_clangd_ast`: call `textDocument/ast`.
- `lm_clangd_typeHierarchy`: call `textDocument/typeHierarchy`.
- `lm_clangd_typeHierarchyResolve`: call `typeHierarchy/resolve`.
- `lm_clangd_lspRequest`: restricted passthrough request tool guarded by `clangd.allowedMethods`.
- `lm_clangd_lspRequest` only allows read-only methods from the built-in allowlist. Methods outside this read-only list are ignored even if configured in `clangd.allowedMethods`.

Auto-start behavior:

- If clangd tools are enabled and clangd is not running, the bridge triggers `clangd.activate` once and retries the request.
- If `clangd.enable=false`, the bridge does not mutate user settings and returns an explicit error when startup fails.
- For all clangd tool inputs/outputs containing `line` and `character`, the bridge uses 1-based indexing for human readability and converts at the LSP boundary.

## Selected change history

- 1.0.56
  - `lm_findFiles` supports `includeIgnoredFiles`.
  - `lm_findTextInFiles` and `lm_findFiles` now apply include globs before exclude globs.
- 1.0.55
  - `lm_findFiles` backend aligned with ripgrep and matches the same exclusion rules as `lm_findTextInFiles`.
  - Tool enablement now stored as `tools.enabledDelta` + `tools.disabledDelta` relative to defaults.
  - Workspace and folder `search.exclude` / `files.exclude` are merged for tool searches.

For the full history from release to beta, see `CHANGELOG.md`.

## VS Code Marketplace change history

VS Code Marketplace typically displays release notes from the root `CHANGELOG.md` when publishing a new version. Recommended process:

1. Maintain `CHANGELOG.md` at repo root.
2. Add `## [x.y.z] - YYYY-MM-DD` sections before each release.
3. Publish with `vsce publish` (or CI). The Marketplace will render the matching release notes.

## Development

- Build once: `npm run compile`
- Watch mode: `npm run watch`

## Logs

Output -> `LM Tools Bridge`:

- `off`: status only
- `simple`: tool name, input, and duration
- `detail`: full tool output, including structuredContent when enabled
