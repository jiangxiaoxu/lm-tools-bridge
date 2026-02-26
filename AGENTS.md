# Agent Instructions

## Session bootstrap

- At the beginning of each conversation, read `face-ai-report.md` first to preload project-specific context before making code decisions.

## Version bump

Root package:

```
npm version patch --no-git-tag-version
```

- When bumping the version, update CHANGELOG.md to keep a clear, user-readable history, and keep CHANGELOG.md entries sorted by version in descending order (latest first).
- For CHANGELOG.md updates, read only the first 20 lines to find the insertion anchor for the latest version section (`## [`), and avoid loading the full file into model context.
- Insert the new release notes at that anchor position instead of appending to the end.
- If no version anchor is found within the first 20 lines, insert the new section after the changelog header/maintenance preamble.

## Tool output formatting

- When implementing custom tools that return text, use `new vscode.LanguageModelTextPart(text)` to avoid double JSON serialization.
- Returning plain objects can be serialized again in the MCP wrapper, which turns `\n` into `\\n` and makes output hard to read.
- If you need JSON output in `text`, stringify once with `JSON.stringify(payload, null, 2)` and wrap it in `LanguageModelTextPart`.
- MCP always wraps responses; only `structuredContent` carries raw objects, while `content.text` is always a string.
- Example (good): `return { content: [new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))] };`
- Example (bad): `return buildToolResult(payload, false, JSON.stringify(payload));` (can be double-serialized by the wrapper)

## Build verification

- After code changes, run `npx @vscode/vsce package --out lm-tools-bridge-latest.vsix` to verify packaging and overwrite the previous VSIX artifact only after a successful package.

## Documentation maintenance

- After modifying code implementation, update face-ai-report.md to keep behavior, settings, flows, and AI report constraints in sync (task-driven, concise, no inline tool lists, update flows/index/matrix/invariants/failures/seeds when behavior changes).
- Keep face-ai-report.md concise and deduplicated: prefer merged entries over repeated lists, keep task-routing information compact, and avoid verbose narrative that increases context load.
- Update README.md only when user-facing behavior changes (for example: commands, settings semantics, endpoints, output contract, workflow steps, troubleshooting guidance, or compatibility notes).
- For internal-only changes (for example refactors, code cleanup, internal module moves, non-user-facing test/tooling updates), README.md update is not required.
- If a change includes code implementation updates and a version bump: always update face-ai-report.md; update README.md only if user-facing behavior changed; update CHANGELOG.md for version history.

## Language requirements

- Text used in code (comments and user-facing output) must be in English.

## TypeScript directives

- `// @ts-expect-error` must include a reason and sit directly above the triggering line.
- In this repo, only `// @ts-expect-error TS2589: Deep instantiation from SDK tool generics.` is allowed by default after reasonable type simplifications; any other use requires explicit user approval.
