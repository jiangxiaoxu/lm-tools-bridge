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

The extension starts a local MCP Streamable HTTP server and exposes tools plus resources. Only tools enabled in settings and not blacklisted are exposed by `vscodeLmToolkit`.

- Endpoint: `http://127.0.0.1:48123/mcp` (host is fixed to `127.0.0.1`)
- Tool names:
  - `vscodeLmToolkit`
  - `getVSCodeWorkspace` (call this first to confirm the workspace before using other tools)
- Resources:
  - `lm-tools://names` (tool names only)
  - `lm-tools://tool/{name}` (full tool detail)
  - `lm-tools://schema/{name}` (input schema only; not listed by `list_mcp_resources`)
  - `lm-tools://policy` (recommended call order policy; use lm-tools://mcp-tool/getVSCodeWorkspace, then lm-tools://schema/{name}, then invokeTool with lm-tools://tool/{name})
  - `lm-tools://mcp-tool/getVSCodeWorkspace` (MCP-native tool description)

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

### Tool input (vscodeLmToolkit)

```json
{
  "action": "listTools | getToolInfo | invokeTool",
  "name": "toolName",
  "detail": "names | full",
  "input": {}
}
```

Note: `action` is **only** for `vscodeLmToolkit` itself. Valid actions: `listTools` | `getToolInfo` | `invokeTool`. `listTools` only allows `action` and optional `detail` and defaults to `detail: "names"`; use `detail: "full"` if you need complete tool info. `getToolInfo` does not accept `detail` and always returns full detail (including `inputSchema`). `invokeTool` requires `name` and optional `input`, which must be an object. The `input` field is for the target tool and must follow its schema (`lm-tools://schema/{name}`).

### MCP native tool: getVSCodeWorkspace

`getVSCodeWorkspace` returns the workspace information that matches the status bar tooltip. Before using any other tool for the first time, call `getVSCodeWorkspace` to verify the workspace. If it does not match, ask the user to confirm. This tool is always available and is not controlled by `tools.enabled`/`tools.blacklist`.

Example call (tools/call):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "getVSCodeWorkspace",
    "arguments": {}
  }
}
```

Example result (multiple workspaces):

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"ownerWorkspacePath\":\"G:\\\\UE_Folder\\\\vscode-lm-tools-bridge; G:\\\\UE_Folder\\\\another-workspace\",\"workspaceFolders\":[{\"name\":\"vscode-lm-tools-bridge\",\"path\":\"G:\\\\UE_Folder\\\\vscode-lm-tools-bridge\"},{\"name\":\"another-workspace\",\"path\":\"G:\\\\UE_Folder\\\\another-workspace\"}]}"
    }
  ]
}
```

### Recommended tool call order

1. Call `getVSCodeWorkspace` to verify the workspace matches the status bar tooltip.
2. Fetch the target tool’s schema via `lm-tools://schema/{name}` (or `listTools detail:"full"`); the schema must be read before invoking.
3. Invoke the tool with `vscodeLmToolkit` once the schema is known.

Following these steps prevents validation errors such as missing `action` or schema mismatches.

### Settings

- `lmToolsBridge.server.autoStart` (default: true)
- `lmToolsBridge.server.port` (default: 48123)
- `lmToolsBridge.useWorkspaceSettings` (default: false; only honored in workspace settings; user/global settings are ignored; when enabled, workspace settings override user settings)
- `lmToolsBridge.tools.enabled` (default: the list above)
- `lmToolsBridge.tools.blacklist` (default: empty array; user-configurable blacklist, combined with internal blacklist)
- `lmToolsBridge.tools.blacklistPatterns` (default: empty string; pipe-delimited wildcard patterns like `*gitk|mcp_*|*a*`; uses `*`, is case-insensitive, and is combined with `tools.blacklist` and the internal blacklist; matches are enforced and do not appear in the blacklist picker)
- `lmToolsBridge.tools.schemaDefaults` (default: `[ "lm_findTextInFiles.maxResults=500" ]`; list of `toolName.paramName=value` entries injected into schemas and tool invocations when the caller omits them; entries not in this format are ignored; values accept quoted strings (`"OK"`), `true`/`false`, numbers, or arrays written as `{a,b,c}` where each element is a quoted string, number, or boolean (whitespace allowed, empty elements allowed); unquoted strings are rejected; JSON is not accepted; example: `[ tool.param=1, tool.param="MyStr", tool.param=true, tool.param={6,4} ]`)
- `lmToolsBridge.tools.responseFormat` (default: `text`; enum: `text` | `structured` | `both`; controls whether tool calls return text content, structuredContent, or both)
- `lmToolsBridge.debug` (default: `off`; enum: `off` | `simple` | `detail`; controls log verbosity for tool calls)

### Configure exposed tools

- Right-click the status bar item and select `LM Tools Bridge: Configure Tools`.
- Use the multi-select list to enable tools. Click **Reset** to restore defaults.
- Tools matching the blacklist are hidden from the picker and are always disabled.
- These controls apply to `vscodeLmToolkit` only.
- `lmToolsBridge.tools.responseFormat` controls tool responses: `text` returns only content.text (human-readable), `structured` returns only structuredContent (machine-readable) with empty content, `both` returns both content.text and structuredContent. Applies to all tools.

### Help and reload

- The status menu includes **Help** (opens the GitHub README).
- **Reload Window** triggers `Developer: Reload Window` to refresh the extension quickly.

### Take over MCP server

When multiple VS Code instances are open, use `LM Tools Bridge: Take Over Server` to stop the existing MCP server on the port and start it in the current instance.

### Status bar indicator

The status bar shows the current-owner state:
- `LM Tools Bridge: Current-owner` (this instance hosts the port)
- `LM Tools Bridge: Other-owner` (another instance hosts the port)
- `LM Tools Bridge: Off` (no server running)

The tooltip includes the owner workspace path(s) and the MCP URL. Click the status bar item to take over when this instance is not the current-owner.

### Logs

Check Output -> `LM Tools Bridge` for MCP server logs.

Debug levels:
- `off`: only status logs (current-owner state + owner workspace path when known). If other-owner and unknown, owner workspace is omitted.
- `simple`: status logs + tool name/input + duration (ms) for listTools/getToolInfo/invokeTool.
- `detail`: adds full tool outputs; if responseFormat is `structured` or `both`, logs structured content too.

### Consent notes

Language Model API usage may still trigger VS Code consent prompts or tool confirmations, depending on the selected model and tool implementations.

## Development

- Build once: `npm run compile`
- Watch mode: `npm run watch`

## Notes

- Requires a VS Code version that exposes the `vscode.lm` API (see `package.json` engines).
