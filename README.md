# LM Tools Bridge

VS Code extension that exposes MCP tools backed by the VS Code Language Model API.

## Usage

1. Open the extension in VS Code.
2. Run `npm install`.
3. Press `F5` to launch the Extension Development Host.
4. Use the status bar menu to dump enabled tools when needed.
5. Check Output -> `LM Tools Bridge`.

## MCP Server

The extension starts a local MCP Streamable HTTP server and exposes two tools plus resources. Only tools enabled in settings and not blacklisted are exposed.

- Endpoint: `http://127.0.0.1:48123/mcp`
- Tool names:
  - `vscodeLmChat`
  - `vscodeLmToolkit`
- Resources:
  - `lm-tools://names` (tool names only)
  - `lm-tools://list` (name/description/tags)
  - `lm-tools://tool/{name}` (full tool detail)
  - `lm-tools://schema/{name}` (input schema only)

`lm-tools://list` also includes `toolUri`, `schemaUri`, and `usageHint` to guide whether to call via `vscodeLmToolkit` or `vscodeLmChat`.

### Default enabled tools

By default, the following tools are enabled for MCP exposure (you can change this via the status bar or settings):

Workspace search/read/diagnostics:
- `copilot_searchCodebase`
- `copilot_searchWorkspaceSymbols`
- `copilot_listCodeUsages`
- `copilot_findFiles`
- `copilot_findTextInFiles`
- `copilot_readFile`
- `copilot_listDirectory`
- `copilot_getErrors`
- `copilot_readProjectStructure`
- `copilot_getChangedFiles`
- `copilot_testFailure`
- `copilot_findTestFiles`
- `copilot_getDocInfo`
- `copilot_getSearchResults`

Terminal output read-only:
- `get_terminal_output`
- `terminal_selection`
- `terminal_last_command`

### Internal blacklist (always disabled)

These tools are always hidden and cannot be enabled via settings:

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
- `runSubagent`
- `vscode_get_confirmation`
- `inline_chat_exit`
- `copilot_getVSCodeAPI`

### Tool input (vscodeLmChat)

```json
{
  "messages": [
    { "role": "user", "content": "Summarize the active file." }
  ],
  "modelId": "gpt-5-mini",
  "modelFamily": "gpt-5-mini",
  "maxIterations": 6,
  "toolMode": "auto",
  "justification": "Run a VS Code chat request with tools",
  "modelOptions": {}
}
```

Note: `role: "system"` is forwarded as a user message named `system` because the API only supports user/assistant roles.

### Tool output (vscodeLmChat)

```json
{
  "text": "...",
  "toolCalls": [
    { "name": "vscode.search", "callId": "call_123" }
  ],
  "iterations": 2,
  "stopReason": "completed",
  "model": {
    "id": "gpt-5-mini",
    "family": "gpt-5-mini"
  }
}
```

### Tool input (vscodeLmToolkit)

```json
{
  "action": "listTools | getToolInfo | invokeTool",
  "name": "toolName",
  "detail": "names | summary | full",
  "input": {},
  "includeBinary": false
}
```

Note: `action` is **only** for `vscodeLmToolkit` itself. The `input` field is for the target tool and must follow its schema (`lm-tools://schema/{name}`).

### Settings

- `lmToolsBridge.server.autoStart` (default: true)
- `lmToolsBridge.server.host` (default: 127.0.0.1)
- `lmToolsBridge.server.port` (default: 48123)
- `lmToolsBridge.chat.modelId` (default: gpt-5-mini)
- `lmToolsBridge.chat.modelFamily` (default: gpt-5-mini)
- `lmToolsBridge.chat.maxIterations` (default: 6)
- `lmToolsBridge.tools.enabled` (default: the list above)
- `lmToolsBridge.tools.blacklist` (default: empty; comma-separated substrings, case-insensitive)

### Configure exposed tools

- Right-click the status bar item and select `LM Tools Bridge: Configure Tools`.
- Use the multi-select list to enable tools. Click **Reset** to restore defaults.
- Tools matching the blacklist are hidden from the picker and are always disabled.


### Take over MCP server

When multiple VS Code instances are open, use `LM Tools Bridge: Take Over Server` to stop the existing MCP server on the port and start it in the current instance.

### Status bar indicator

The status bar shows the ownership state:
- `LM Tools Bridge: Owner` (this instance hosts the port)
- `LM Tools Bridge: In Use` (another instance hosts the port)
- `LM Tools Bridge: Off` (no server running)

Click the status bar item to take over when not owning the port.

### Logs

Check Output -> `LM Tools Bridge` for MCP server logs.

### Consent notes

Language Model API usage may still trigger VS Code consent prompts or tool confirmations, depending on the selected model and tool implementations.

## Development

- Build once: `npm run compile`
- Watch mode: `npm run watch`

## Notes

- Requires a VS Code version that exposes the `vscode.lm` API (see `package.json` engines).
