# Stdio Manager And Bridge Flow

## Bind And Discovery
- `lmToolsBridge_bindWorkspace` is the session-binding entrypoint.
- Agents should read `lm-tools://guide` before first use, bind with an absolute project path or `.code-workspace` path, and rebind only when the workspace target changes or the bound workspace goes offline.
- Workspace instances publish deterministic discovery pipes derived from normalized `folder|...` or `workspace-file|...` identities.
- Discovery candidate order is upward and exact; `.code-workspace` candidates are checked before folder candidates at the same level.
- Unsaved untitled multi-root workspaces are not published for manager discovery; users must save them as a real `.code-workspace` file first.
- On Windows, `lmToolsBridge_bindWorkspace` accepts normal absolute paths and `\\?\` + normal absolute paths; non-normal NT namespace forms are rejected.
- If no healthy discovery pipe answers on Windows, handshake may auto-start VS Code with `code.cmd` then `code`, always with `--new-window`.

## ToolDefinition Cache Contract
- `discovery.bridgedTools` is names-only; names alone are not ToolDefinitions.
- `discovery.toolDefinitionsTool` describes `lmToolsBridge_getToolDefinitions` and includes input/output schemas.
- Before invoking a bridged tool, have that exact tool's full ToolDefinition from `lmToolsBridge_getToolDefinitions`.
- Use `lmToolsBridge_getToolDefinitions` only with tool names whose ToolDefinitions are unknown.
- Reuse known ToolDefinitions; do not request the same known tool again.
- Do not guess or infer ToolDefinitions or input schemas; definitions returned by the helper are the source of truth.
- Helper-returned ToolDefinitions include `name`, `description`, `inputSchema`, and optional `outputSchema`; they omit VS Code metadata such as `tags`.
- For arguments named `pathScope`, use the compact syntax summary in the parameter description and the full syntax in `lm-tools://guide`.
- During bind, the manager reads the workspace-internal `lm-tools://tool-definitions` resource for full ToolDefinitions, but the stdio MCP frontend exposes only `lm-tools://guide` and `lm-tools://tool-names` as resources.
- `lmToolsBridge_getToolDefinitions` requires an active workspace bind and is rejected as a `lmToolsBridge_callBridgedTool` target.
- Tool-definition payloads do not include helper metadata like `toolUri` or `usageHint`.

## Runtime Reload And Offline Recovery
- Successful bind payloads omit redundant top-level `online`, `health`, and `mcpSessionId`.
- Successful bind payload `target` is workspace identity only: `workspaceFolders` and `workspaceFile`.
- Successful runtime generation changes invalidate the current workspace bind without dropping the stdio transport.
- Fatal runtime reload failures make the stdio manager unavailable until VS Code creates a fresh manager.
- If the bound workspace goes offline after handshake, the stdio manager clears binding and returns offline/rebind errors.
- Workspace mismatch, unreachable, offline, and invalid direct-call errors include actionable `Next step:` guidance.

## Windows Publication
- Extension activation syncs the bundled stdio manager bootstrap/runtime pair to `%LOCALAPPDATA%\\lm-tools-bridge`.
- Metadata carries generation, file names, artifact hashes, and sync timestamp.
- Publication is guarded by a global named-pipe lock and notifies live manager control pipes after generation changes.
- Legacy `%LOCALAPPDATA%\\lm-tools-bridge\\instances` cleanup is best-effort and must not block activation.
- External `node` availability is checked on activation; missing Node shows one non-blocking warning per extension-host lifetime with install/download choices.
