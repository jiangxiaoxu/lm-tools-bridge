# Agent Instructions

## Version bump

Root package:

```
npm version patch --no-git-tag-version
```

Subpackage (run inside the subpackage directory, use `version patch` there; do not use `--prefix`):

```
cd lm-tools-bridge-proxy
npm version patch --no-git-tag-version
```

## Publish

- Publish the proxy from inside `lm-tools-bridge-proxy` (use `npm publish` there; do not use `--prefix`).

Example:

```
cd lm-tools-bridge-proxy
npm publish
```
- Do not use `npm --prefix ... publish`; it can publish the root `lm-tools-bridge` by mistake.
- The root package requires 2FA (OTP) for publish/unpublish.

## Tool output formatting

- When implementing custom tools that return text, use `new vscode.LanguageModelTextPart(text)` to avoid double JSON serialization.
- Returning plain objects can be serialized again in the MCP wrapper, which turns `\n` into `\\n` and makes output hard to read.
- If you need JSON output in `text`, stringify once with `JSON.stringify(payload, null, 2)` and wrap it in `LanguageModelTextPart`.
- MCP always wraps responses; only `structuredContent` carries raw objects, while `content.text` is always a string.
- Example (good): `return { content: [new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))] };`
- Example (bad): `return buildToolResult(payload, false, JSON.stringify(payload));` (can be double-serialized by the wrapper)
