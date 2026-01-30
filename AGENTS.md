# Agent Instructions

## Version bump

Root package:

```
npm version patch --no-git-tag-version
```

## Publish

- The root package requires 2FA (OTP) for publish/unpublish.

## Tool output formatting

- When implementing custom tools that return text, use `new vscode.LanguageModelTextPart(text)` to avoid double JSON serialization.
- Returning plain objects can be serialized again in the MCP wrapper, which turns `\n` into `\\n` and makes output hard to read.
- If you need JSON output in `text`, stringify once with `JSON.stringify(payload, null, 2)` and wrap it in `LanguageModelTextPart`.
- MCP always wraps responses; only `structuredContent` carries raw objects, while `content.text` is always a string.
- Example (good): `return { content: [new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))] };`
- Example (bad): `return buildToolResult(payload, false, JSON.stringify(payload));` (can be double-serialized by the wrapper)
