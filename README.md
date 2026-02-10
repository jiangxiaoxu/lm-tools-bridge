# LM Tools Bridge

### Overview
LM Tools Bridge is a VS Code extension that exposes LM tools through MCP HTTP.
It uses a built-in Manager to route requests to the correct workspace MCP server.

This README covers the current Manager-based version only.

### Quick Start
1. Start the extension server in VS Code with `LM Tools Bridge: Start Server` (or enable `lmToolsBridge.server.autoStart`).
2. In your MCP client, connect to Manager endpoint `http://127.0.0.1:47100/mcp` (or `http://127.0.0.1:<lmToolsBridge.manager.httpPort>/mcp`).
3. Before tool calls, run handshake `lmToolsBridge.requestWorkspaceMCPServer` with `{ "cwd": "<your project path>" }`.
4. After handshake, call `resources/list`, read `lm-tools://schema/{name}` for first-time tools, then call tools.

### Endpoints
- Manager MCP endpoint (client entry): `http://127.0.0.1:47100/mcp`
- Manager status endpoint (diagnostics): `http://127.0.0.1:47100/mcp/status`
- Workspace MCP endpoint (dynamic target): `http://127.0.0.1:<runtime-port>/mcp`

### Manager vs Workspace MCP Server
- Manager is the stable client-facing MCP endpoint.
- Workspace MCP server is hosted by a VS Code instance and can change across instances or restarts.
- Manager performs workspace matching by `cwd`, health checks, and request forwarding.
- For user stability, connect MCP clients to Manager, not directly to workspace MCP ports.

### How To Connect Your MCP Client
1. Configure MCP URL to `http://127.0.0.1:47100/mcp` (or custom manager port).
2. Send `initialize`, keep the returned `Mcp-Session-Id` header.
3. Call `lmToolsBridge.requestWorkspaceMCPServer` with `cwd`.
4. Use `lmToolsBridge.callTool` or standard `tools/call` after schema read.
5. If session header is lost/expired (`Missing Mcp-Session-Id` or `Unknown Mcp-Session-Id`), re-initialize and handshake again.

Example config:

```toml
[mcp_servers.lm_tools_bridge]
url = "http://127.0.0.1:47100/mcp"
```

### How Port Avoidance Works
- Preferred workspace port starts from `lmToolsBridge.server.port`.
- Manager `POST /allocate` tries to reserve a non-conflicting candidate port.
- Allocation considers active instance ports and short-term reservations, to reduce collisions between VS Code instances.
- When extension binds socket, if `EADDRINUSE` occurs, it auto-increments and retries (up to 50 attempts).
- If retries are exhausted, status bar shows `Port In Use`.
- Even if Manager is temporarily unavailable, extension still tries local incremental bind for availability.

User guidance:
- Do not hardcode workspace MCP runtime port in MCP clients.
- Always connect client to Manager `/mcp` and do handshake per workspace.

### Daily Usage
- `Configure Exposure Tools`: choose tools that can be selected.
- `Configure Enabled Tools`: choose active tools within exposed set.
- `Status Menu -> Open Settings`: jump directly to this extension's settings page.
- Built-in disabled tools are always blocked and never callable.
- Some default tools are policy-required exposure items.

### Diagnostics Tool
- `lm_getDiagnostics` reads diagnostics from VS Code Problems data source (`vscode.languages.getDiagnostics`).
- Inputs: optional `filePath`, optional `severities` (`error|warning|information|hint`), optional `maxResults` (default `500`).
- Default severities are `error` and `warning`.
- Structured diagnostics no longer include `uri`; each diagnostic includes `preview`, `previewUnavailable`, and `previewTruncated`.
- `preview` returns source code lines from `startLine` to `endLine`, capped at 10 lines.
- `copilot_getErrors` is still available for compatibility, but `lm_getDiagnostics` provides stable structured output.

### Troubleshooting
- `workspace not set`:
  - Run `lmToolsBridge.requestWorkspaceMCPServer` with `cwd` first.
- `workspace not matched`:
  - Check `cwd` points inside the target workspace folder.
- `resolved MCP server is offline`:
  - Ensure target VS Code instance and extension server are running.
  - Re-run handshake.
- Client stops working after port change:
  - Connect to Manager `/mcp` instead of old workspace runtime port.
- `Tool not found or disabled`:
  - Ensure the tool is both exposed and enabled.

### Tool Output Mapping
- LM tool `LanguageModelTextPart` is used as `content.text`.
- `content.text` is forwarded from `LanguageModelTextPart` only, without falling back to `LanguageModelDataPart`.
- LM tool `LanguageModelDataPart` with JSON mime type (`application/json`, `application/json; charset=utf-8`, or `*+json`) is parsed as JSON object and used as `structuredContent` when possible.
- If no JSON object is available for `structuredContent`, bridge falls back to `{ blocks: [...] }`.

### Clangd Tools (Optional)
Enable clangd MCP tools with:
- `lmToolsBridge.clangd.enabled`
- Clangd tools are exposed by default but not enabled by default.

Notes:
- AI-first tools now use `filePath` input instead of `uri`.
- `filePath` supports:
- workspace-prefixed path, for example `UE5/Engine/Source/...`
- absolute path, for example `G:/UE_Folder/...` or `G:\\UE_Folder\\...`
- `file:///...` URI input is rejected.
- AI-first outputs use summary text blocks:
- first line `counts ...`
- second line `---`
- then repeated `<path>#<lineOrRange>` + summary line entries with `---` separators
- AI-first clangd tools also return `structuredContent` with machine-stable fields:
- location fields use `absolutePath` (always) + `workspacePath` (nullable)
- line/character fields remain numeric 1-based fields, not `path#...` strings
- structured outputs avoid echoing raw input arguments
- `lm_clangd_symbolSearch` now includes full symbol signature by default in both text summary and `structuredContent`.
- `lm_clangd_symbolInfo` snippet source excludes generated files (`*.generated.h`, `*.gen.cpp`) by default.
- `lm_clangd_symbolInfo` now uses adaptive symbol-category output and includes `typeDefinition` for value-like symbols when meaningful.
- `lm_clangd_typeHierarchy` `SOURCE` section now emits `type -> preview -> path` to improve AI readability.
- `lm_clangd_typeHierarchy` `structuredContent.sourceByClass` includes `absolutePath/workspacePath/startLine/endLine/preview`.
- summary path format is `WorkspaceName/...#line` for workspace files, absolute path for external files.
- Default exposed clangd AI tools:
- `lm_clangd_status`
- `lm_clangd_switchSourceHeader`
- `lm_clangd_typeHierarchy`
- `lm_clangd_symbolSearch`
- `lm_clangd_symbolBundle`
- `lm_clangd_symbolInfo`
- `lm_clangd_symbolReferences`
- `lm_clangd_symbolImplementations`
- `lm_clangd_callHierarchy`
- `lm_clangd_lspRequest` is controlled by `lmToolsBridge.clangd.enablePassthrough` and `lmToolsBridge.clangd.allowedMethods`.
- With `lmToolsBridge.clangd.autoStartOnInvoke=true`, clangd can auto-start on first clangd tool invocation.
- `clangd.enable` is clangd extension setting, not an `lmToolsBridge.*` setting.

### Key Settings
- `lmToolsBridge.server.autoStart`
- `lmToolsBridge.server.port`
- `lmToolsBridge.manager.httpPort`
- `lmToolsBridge.useWorkspaceSettings` is workspace-only. If it is written in User settings, the extension removes it automatically and shows a warning.
- `lmToolsBridge.tools.exposedDelta`
- `lmToolsBridge.tools.unexposedDelta`
- `lmToolsBridge.tools.enabledDelta`
- `lmToolsBridge.tools.disabledDelta`
- `lmToolsBridge.tools.groupingRules`
- `lmToolsBridge.tools.schemaDefaults`
- `lmToolsBridge.tools.responseFormat`
- `lmToolsBridge.debug`

Recommendation:
- If you need to change connection port, adjust `lmToolsBridge.manager.httpPort` for clients first.

### Commands
- `lm-tools-bridge.start`
- `lm-tools-bridge.stop`
- `lm-tools-bridge.configureExposure`
- `lm-tools-bridge.configureEnabled`
- `lm-tools-bridge.statusMenu`
- `lm-tools-bridge.openHelp`

### Logs
Open Output panel and select `LM Tools Bridge`.

- `off`: status only
- `simple`: tool name, input, duration
- `detail`: includes full output

### Full Change History
See `CHANGELOG.md`.

---

