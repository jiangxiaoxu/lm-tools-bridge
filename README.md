# LM Tools Bridge

VS Code extension that exposes MCP tools backed by the VS Code Language Model API.

## Usage

1. Open the extension in VS Code.
2. Run `npm install`.
3. Press `F5` to launch the Extension Development Host.
4. Click the status bar item to open the LM Tools Bridge menu.
5. Use **Dump Enabled Tools** to inspect tools when needed.
6. Check Output -> `LM Tools Bridge`.

## MCP Server

The extension starts a local MCP Streamable HTTP server and exposes tools plus resources. Only tools enabled in settings and not blacklisted are exposed directly via MCP (`tools/list` + `tools/call`).

- Endpoint: `http://127.0.0.1:48123/mcp` (host is fixed to `127.0.0.1`)
- Manager status endpoint: `http://127.0.0.1:47100/mcp/status`
- Tool names:
  - All enabled tools from `lmToolsBridge.tools.enabled` (filtered by blacklist settings)
- Resources:
- `lm-tools://names` (tool names only)
- `lm-tools://tool/{name}` (full tool detail)
- `lm-tools://schema/{name}` (input schema only; not listed by `list_mcp_resources`)
- `lm-tools-bridge://callTool` (manager bridge help, listed only after handshake)

Use `lm-tools://schema/{name}` to fetch input structure when needed.
Resource list entries include `uri`, `name`, and `description` (no `title`) to minimize payload.

### Default enabled tools

By default, the following tools are enabled for MCP exposure (you can change this via the status bar or settings):

Workspace search/read/diagnostics:
- `copilot_searchCodebase`
- `copilot_searchWorkspaceSymbols`
- `copilot_listCodeUsages`
- `lm_findFiles` (lm_ prefix indicates custom tool)
- `lm_findTextInFiles` (lm_ prefix indicates custom tool)
- `copilot_getErrors`
- `copilot_readProjectStructure`
- `copilot_getChangedFiles`
- `copilot_testFailure`
- `copilot_findTestFiles`
- `copilot_getSearchResults`

Terminal output read-only:
- `get_terminal_output`
- `terminal_selection`
- `terminal_last_command`

### Internal blacklist (always disabled)

These tools are always hidden and cannot be configured or enabled via settings:

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
- `get_terminal_output`
- `terminal_selection`
- `terminal_last_command`
- `copilot_findTestFiles`
- `copilot_getSearchResults`
- `copilot_githubRepo`
- `copilot_testFailure`
- `copilot_getChangedFiles`
- `copilot_findFiles`
- `copilot_findTextInFiles`
- `copilot_readFile`

### Tool input (tools/call)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "lm_findFiles",
    "arguments": {
      "query": "src/**/*.ts",
      "maxResults": 20
    }
  }
}
```

Use `lm-tools://schema/{name}` to fetch the tool input schema before calling. The `arguments` field must be an object that matches the schema.

### Manager direct bridge tool

The manager exposes a helper tool for environments that lack a generic `tools/call` function. You must complete the workspace handshake first (`lmToolsBridge.requestWorkspaceMCPServer`).
The tool is always listed by the manager, but calls will return a JSON-RPC error until the handshake succeeds.

Tool name: `lmToolsBridge.callTool`

Input:

```json
{
  "name": "lm_findFiles",
  "arguments": {
    "query": "src/**/*.ts",
    "maxResults": 20
  }
}
```

This bridge forwards the call to the resolved workspace MCP server and returns the target tool result.

### Recommended tool call order

1. Fetch the target tool’s schema via `lm-tools://schema/{name}` (or `lm-tools://tool/{name}` for full metadata).
2. Invoke the tool with `tools/call` once the schema is known.

Following these steps prevents validation errors such as schema mismatches.

### Settings

- `lmToolsBridge.server.autoStart` (default: true)
- `lmToolsBridge.server.port` (default: 48123)
- `lmToolsBridge.manager.httpPort` (default: 47100)
- `lmToolsBridge.useWorkspaceSettings` (default: false; only honored in workspace settings; user/global settings are ignored; when enabled, workspace settings override user settings)
- `lmToolsBridge.tools.enabled` (default: the list above)
- `lmToolsBridge.tools.blacklist` (default: empty array; user-configurable blacklist, combined with internal blacklist)
- `lmToolsBridge.tools.blacklistPatterns` (default: empty string; pipe-delimited wildcard patterns like `*gitk|mcp_*|*a*`; uses `*`, is case-insensitive, and is combined with `tools.blacklist` and the internal blacklist; matches are enforced and do not appear in the blacklist picker)
- `lmToolsBridge.tools.schemaDefaults` (default: `[ "lm_findTextInFiles.maxResults=500" ]`; list of `toolName.paramName=value` entries injected into schemas and tool invocations when the caller omits them; entries not in this format are ignored; values accept quoted strings (`"OK"`), `true`/`false`, numbers, or arrays written as `{a,b,c}` where each element is a quoted string, number, or boolean (whitespace allowed, empty elements allowed); unquoted strings are rejected; JSON is not accepted; example: `[ tool.param=1, tool.param="MyStr", tool.param=true, tool.param={6,4} ]`)
- `lmToolsBridge.tools.responseFormat` (default: `text`; enum: `text` | `structured` | `both`; controls whether tool calls return text content, structuredContent, or both)
- `lmToolsBridge.debug` (default: `off`; enum: `off` | `simple` | `detail`; controls log verbosity for tool calls)

`lm_findTextInFiles` extra params:
- `caseSensitive` (boolean): enable case-sensitive matching; when false, smart-case is used by default (including regex); regex inline flags can override this setting.

### Configure exposed tools

- Right-click the status bar item and select `LM Tools Bridge: Configure Tools`.
- Use the multi-select list to enable tools. Click **Reset** to restore defaults.
- Tools matching the blacklist are hidden from the picker and are always disabled.
- These controls apply to the MCP-exposed tool list.
- `lmToolsBridge.tools.responseFormat` controls tool responses: `text` returns only content.text (human-readable), `structured` returns only structuredContent (machine-readable) with empty content, `both` returns both content.text and structuredContent. Applies to all tools.

### Help and reload

- The status menu includes **Help** (opens the GitHub README).
- **Reload Window** triggers `Developer: Reload Window` to refresh the extension quickly.

### Status bar indicator

The status bar shows the server state:
- `LM Tools Bridge: Running`
- `LM Tools Bridge: Port In Use`
- `LM Tools Bridge: Off`

The tooltip includes the MCP URL and basic state details.

### Logs

Check Output -> `LM Tools Bridge` for MCP server logs.

Debug levels:
- `off`: only status logs (running/off state + workspace path when known).
- `simple`: status logs + tool name/input + duration (ms) for tools/call.
- `detail`: adds full tool outputs; if responseFormat is `structured` or `both`, logs structured content too.

### Consent notes

Language Model API usage may still trigger VS Code consent prompts or tool confirmations, depending on the selected model and tool implementations.

## Development

- Build once: `npm run compile`
- Watch mode: `npm run watch`

## Notes

- Requires a VS Code version that exposes the `vscode.lm` API (see `package.json` engines).
- The manager process is restarted on extension reload when its version does not match the extension version. Shutdown requests validate the manager version to reduce restart races across VS Code instances.
