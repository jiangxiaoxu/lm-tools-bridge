# Runtime Contracts

## Hard Invariants
- Effective callable tools = exposed set intersection enabled set.
- VS Code-sourced `vscode.lm.tools` are exposed to MCP with an `lm_` prefix, while invocation routes back to the original VS Code tool name.
- Exact-name tool config entries auto-migrate legacy non-`lm_` VS Code tool names during tool-state normalization; grouping rules only warn on likely legacy regex fragments.
- If a normalized VS Code tool name collides with an existing custom `lm_*` tool, keep the custom tool and skip the VS Code tool with a warning.
- `tools.unexposedDelta` overrides `tools.exposedDelta`; `tools.disabledDelta` overrides `tools.enabledDelta`.
- Built-in disabled tools must be pruned from all tool delta settings.
- Extension-managed `lmToolsBridge.*` settings use resource scope.
- `lm_getDiagnostics` uses `vscode.languages.getDiagnostics`.
- Built-in `lm_*` path fields in structured payloads use absolute paths when structured payloads are returned.
- Custom tool `content.text` summaries are sanitized before returning.

## Public Runtime Shape
- The local MCP HTTP server auto-starts on extension activation; legacy manual start/stop commands and `lmToolsBridge.server.autoStart` are not part of the current public surface.
- The supported runtime path is stdio manager plus named-pipe workspace discovery; the legacy HTTP manager/status-page/file-registry implementation is removed.
- Server and qgrep status bar items are separate.
- Runtime logs: server logs use `lm-tools-bridge`, tool debug logs use `lm-tools-bridge-tools`, and qgrep logs use `lm-tools-bridge-qgrep`.

## Forbidden Assumptions
- Do not assume handshake can be skipped before workspace tool calls.
- Do not assume `tools/list` stays fixed before and after handshake.
- Do not assume User settings drive scope when `useWorkspaceSettings=true`.
- Do not assume forwarded LM tools always include both text and structured channels.
- Do not assume post-handshake offline calls will auto-start VS Code again.
- Do not assume historical notes describe current runtime behavior.

