# Changelog

All notable changes to this project will be documented in this file.

## [1.0.56] - 2026-02-03
- Added `includeIgnoredFiles` to `lm_findFiles` (schema + rg flags).
- Applied include globs before exclude globs in `lm_findTextInFiles` and `lm_findFiles` so excludes still take effect.

## [1.0.55] - 2026-02-03
- Merged workspace and folder `search.exclude` / `files.exclude` so `.code-workspace` exclusions are honored.
- Unified exclusion configuration for `lm_findTextInFiles` and `lm_findFiles`.

## [1.0.54] - 2026-02-02
- Switched `lm_findFiles` backend to ripgrep (`rg --files`) for consistent file discovery.
- Reworked tool enablement storage to `tools.enabledDelta` + `tools.disabledDelta` relative to defaults.
- Default enabled tools now use `lm_findFiles` / `lm_findTextInFiles`; set `lm_findFiles.maxResults=200` by default.

## [1.0.53] - 2026-02-01
- Enabled `copilot_findFiles` and `copilot_findTextInFiles` by default.
- Removed copilot find tools from the built-in blacklist while keeping schema default overrides.

## [1.0.52] - 2026-01-31
- Refined schema discovery guidance: keep schema entries template-only in `resources/list`.
- Clarified handshake flow to read `lm-tools://schema/{name}` once before the first tool call.

## [1.0.51] - 2026-01-31
- Expanded handshake resource guidance and added rebind hints for expired sessions.

## [1.0.50] - 2026-01-31
- Improved MCP discovery and handshake SSE behavior.
- Listed schema resources after handshake and returned MethodNotFound for unknown tools.
- Sent `resources/tools list_changed` notifications via SSE to trigger client refresh.
- Formalized the Manager control endpoint (default `47100`) as the handshake/status entry point.

## [1.0.49] - 2026-01-31
- Latest release branch baseline used for this changelog.
