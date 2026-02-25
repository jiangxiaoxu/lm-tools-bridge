# Source Layout

This folder is organized by responsibility to keep the extension entrypoint small and the tooling logic isolated.

- extension.ts: VS Code activation, commands, status bar, HTTP server routing, and MCP resource wiring.
- configuration.ts: Configuration access helpers and workspace/global resolution.
- managerClient.ts: Manager process control, restart workflow, and IPC/HTTP coordination with the manager.
- manager.ts: Manager process server implementation and lifecycle.
- tooling.ts: Tool exposure, schema defaults, MCP tool registration, and tool invocation formatting.
- qgrep.ts: qgrep binary integration, workspace index lifecycle, and custom qgrep search backend.
- toolGrouping.ts: Source-based tool grouping helpers for the configuration UI.
- toolConfigPanel.ts: Webview-based tree configuration panel for exposure/enabled tool selection.
- clangd/: Isolated clangd MCP tool layer (client bootstrap, transport, schemas, and tool implementations).
- searchTools.ts: Workspace search helpers used by custom find tools.
