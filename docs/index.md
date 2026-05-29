# AI Context Index: lm-tools-bridge

## Preload Contract
- Project one-liner: expose VS Code LM tools through per-workspace local MCP HTTP servers plus a per-session stdio manager that binds via deterministic workspace-discovery pipes.
- Audience: AI agent performing code changes with minimal repo traversal.
- Version baseline: `1.0.171`.
- Read this file first, then jump to the task-relevant document below.

## Core Reading Map
- Runtime invariants and forbidden assumptions: [`ai-report/runtime-contracts.md`](ai-report/runtime-contracts.md).
- Bind, discovery, `lm-tools://guide`, ToolDefinition caching, runtime reload: [`ai-report/stdio-manager.md`](ai-report/stdio-manager.md).
- Tool exposure/enabled policy, config scope, pathScope, diagnostics, formatting: [`ai-report/tools-and-config.md`](ai-report/tools-and-config.md).
- qgrep query semantics, index lifecycle, recovery, status, output: [`ai-report/qgrep.md`](ai-report/qgrep.md).
- Task routing cards and change impact map: [`ai-report/routing-and-impact.md`](ai-report/routing-and-impact.md).
- Verification checklist and test command selection: [`ai-report/verification.md`](ai-report/verification.md).
- Historical or unreachable notes only: [`ai-report/archive.md`](ai-report/archive.md).

## Highest-Priority Invariants
- Effective callable tools = exposed set intersection enabled set.
- VS Code-sourced `vscode.lm.tools` are exposed as `lm_*`; runtime invocation still routes to the original VS Code source name.
- Shared `pathScope` syntax is embedded in `lm-tools://guide` and applies to any tool argument named `pathScope`.
- `discovery.bridgedTools` is names-only; names alone are not ToolDefinitions.
- Before invoking a bridged tool, have that exact tool's full ToolDefinition from `lmToolsBridge_getToolDefinitions`.
- Use `lmToolsBridge_getToolDefinitions` only with tool names whose ToolDefinitions are unknown; do not guess definitions or input schemas.
- Reuse known ToolDefinitions; do not request the same known tool again.
- qgrep tools are default enabled, text-only, and return absolute-path output.
- Successful runtime generation changes invalidate the current stdio manager bind without dropping the stdio transport.
- README updates are needed only for user-facing behavior changes; changelog updates are needed on version bumps.

## Maintenance Rules
- Keep this index concise and task-directed; put detailed behavior in the topic files.
- After code implementation changes, update the relevant `docs/ai-report/*` document and this index only when routing or invariants change.
- Do not describe historical or removed runtime behavior as current mainline; move it to `ai-report/archive.md`.
