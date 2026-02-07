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

## Built-in blacklist

These tools are always disabled and cannot be enabled via settings:

- `copilot_applyPatch`
- `copilot_insertEdit`
- `copilot_replaceString`
- `copilot_multiReplaceString`
- `copilot_createFile`
- `copilot_createDirectory`
- `copilot_createNewJupyterNotebook`
- `copilot_editNotebook`
- `copilot_runNotebookCell`
- `copilot_createNewWorkspace`
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
- `copilot_listDirectory`
- `runSubagent`
- `vscode_get_confirmation`
- `vscode_get_terminal_confirmation`
- `inline_chat_exit`
- `copilot_getVSCodeAPI`
- `copilot_findFiles`
- `copilot_findTextInFiles`
- `copilot_readFile`

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
- `lmToolsBridge.tools.enabledDelta` (default: `[]`; additional enables relative to defaults)
- `lmToolsBridge.tools.disabledDelta` (default: `[]`; additional disables relative to defaults)
- `lmToolsBridge.tools.enabled` has been removed. Use `tools.enabledDelta` / `tools.disabledDelta` instead.
- `lmToolsBridge.tools.blacklist` (default: `[]`)
- `lmToolsBridge.tools.blacklistPatterns` (default: `""`; `*` wildcard, `|`-delimited)
- `lmToolsBridge.tools.schemaDefaults` (defaults defined in extension configuration)
- `lmToolsBridge.tools.responseFormat` (default: `text`; `text` | `structured` | `both`)
- `lmToolsBridge.debug` (default: `off`; `off` | `simple` | `detail`)

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
