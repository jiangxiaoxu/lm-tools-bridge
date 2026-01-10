# LM Tools Bridge

VS Code extension that exposes MCP tools backed by the VS Code Language Model API.

## Usage

1. Open the extension in VS Code.
2. Run `npm install`.
3. Press `F5` to launch the Extension Development Host.
4. (Optional) In the Extension Development Host, press `Ctrl+Shift+P` and run `lm-tools-bridge.dump`.
5. Check Output -> `LM Tools Bridge`.

## MCP Server

The extension starts a local MCP Streamable HTTP server and exposes two tools plus resources. Only tools in a fixed whitelist are exposed.

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

### Allowed tools (whitelist)

Only the following tools are exposed via MCP:

Workspace search/read/diagnostics:
- `copilot_searchCodebase`
- `copilot_searchWorkspaceSymbols`
- `copilot_listCodeUsages`
- `copilot_getVSCodeAPI`
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
- `lmToolsBridge.tools.disabled` (default: [])


### Take over MCP server

When multiple VS Code instances are open, use `LM Tools Bridge: Take Over Server` to stop the existing MCP server on the port and start it in the current instance.

### Status bar indicator

The status bar shows the MCP ownership state:
- `MCP: Owner` (this instance hosts the port)
- `MCP: In Use` (another instance hosts the port)
- `MCP: Off` (no server running)

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
