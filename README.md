# LM Tools Dump

VS Code extension that dumps `vscode.lm.tools` to the Output panel and exposes them via an MCP server.

## Usage

1. Open the extension in VS Code.
2. Run `npm install`.
3. Press `F5` to launch the Extension Development Host.
4. In the Extension Development Host, press `Ctrl+Shift+P` and run `lm-tools-dump`.
5. Check Output -> `LM Tools`.

## MCP Server

The extension starts a local MCP Streamable HTTP server and exposes a single tool plus resources.

- Endpoint: `http://127.0.0.1:48123/mcp`
- Tool name: `vscodeLmToolkit`
- Resources:
  - `lm-tools://names` (tool names only)
  - `lm-tools://list` (name/description/tags)
  - `lm-tools://tool/{name}` (full tool detail)
  - `lm-tools://schema/{name}` (input schema only)

### Tool input (vscodeLmToolkit)

```json
{
  "action": "listTools | getToolInfo | invokeTool",
  "name": "toolName",
  "detail": "names | summary | full",
  "input": { },
  "maxChars": 2000,
  "includeBinary": false
}
```

### Settings

- `lmToolsMcp.server.autoStart` (default: true)
- `lmToolsMcp.server.host` (default: 127.0.0.1)
- `lmToolsMcp.server.port` (default: 48123)
- `lmToolsMcp.tools.disabled` (default: [])

### Configure exposed tools

Run `LM Tools MCP: Configure Exposed Tools` from the Command Palette to enable/disable tools. Use the reset option to enable all tools again.

## Development

- Build once: `npm run compile`
- Watch mode: `npm run watch`

## Notes

- Requires a VS Code version that exposes the `vscode.lm` API (see `package.json` engines).
