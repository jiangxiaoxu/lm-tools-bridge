# qgrep Contracts

## Tool Surface
- `lm_qgrepSearchText` and `lm_qgrepSearchFiles` are built-in required exposed tools and default enabled tools.
- They execute the bundled qgrep binary at `bin/qgrep.exe`.
- `lm_qgrepGetStatus` reports qgrep binary/workspace/index progress status and does not require qgrep init.
- On indexed workspaces, prefer qgrep search tools before ripgrep-based tools for repeated searches.

## Text Query Semantics
- `lm_qgrepSearchText` defaults to `querySyntax='literal'`; set `querySyntax='regex'` for regex.
- Smart-case applies when `caseSensitive` is false or omitted; `caseSensitive=true` forces sensitive matching.
- Literal top-level unescaped `|` splits into multiple branches without trimming whitespace.
- Whitespace-only branches between two pipe separators are discarded.
- Whole branches wrapped exactly by outer double quotes keep `|` literal.
- Malformed quotes are ordinary characters, unquoted `\|` keeps `|` literal, and truly empty split branches fall back to the raw literal.
- Context line counts default to `0` and clamp to `50`; oversized requests include requested/applied values.

## File Query Semantics
- `lm_qgrepSearchFiles` accepts `query`, `querySyntax`, and `maxResults`.
- Glob mode follows VS Code glob semantics; regex mode evaluates the query as regex.
- Glob patterns without `/` are treated as any-depth file globs.
- Non-absolute glob patterns match workspace-relative paths and are anchored to each target workspace root.
- Multi-root glob and regex modes support `WorkspaceName/...` scoping.
- Bare `|` alternation is rejected in glob mode; use braces or regex mode.
- Legacy `mode`, `searchPath`, and `isRegexp` are rejected; `includeIgnoredFiles` is tolerated but ignored.

## Output And Limits
- Both qgrep tools default `maxResults` to `300` and clamp to `2000`.
- Payloads include `totalAvailable`; capped lower-bound states include `totalAvailableCapped`.
- `hardLimitHit` is returned only when the backend query limit is hit.
- Successful qgrep responses are text-only `LanguageModelTextPart` responses.
- Output paths are absolute with `/`; `====` separates files and `---` separates same-file context blocks.
- qgrep query errors use short fixed messages: `Invalid qgrep query`, `Qgrep unavailable`, and `Qgrep indexing timeout`.

## Index Lifecycle
- qgrep search/files auto-initialize all current workspaces on demand before searching.
- Already-initialized workspaces queue a startup refresh that syncs managed config before `qgrep update`.
- Index operations (`init`, `update`, `build`) are serialized per workspace.
- Search/files block while qgrep is uninitialized, indexing, or actively recovering.
- Successful update/build completion finalizes readiness even without a final parsed `100%` frame.
- Recoverable update failures retry twice before fallback rebuild.
- Startup refresh attempts one rebuild for corruption-like assertion failures containing `Assertion failed` plus `filter.cpp` or `entries.entries`.
- Stalled partial watch progress restarts once for the same signature, then escalates to rebuild if repeated.
- `Qgrep Stop And Clear Indexes` cancels in-flight index commands, waits briefly for child exits, retries locked directory deletion, and disables maintenance until re-init.

## Managed Config And UI
- `workspace.cfg` includes extension-managed Unreal, PowerShell, and `search.exclude=true` blocks plus fixed excludes.
- Generated qgrep regexes avoid Perl-style `(?...)` constructs because qgrep rejects them.
- qgrep status bar shows `qgrep not initialized` when no workspace index exists.
- qgrep tooltip reports binary readiness, aggregate progress, and per-workspace `A/B (percent)` lines.

