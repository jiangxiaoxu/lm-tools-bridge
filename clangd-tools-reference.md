# clangd Tools Reference

## Scope
This file documents current `lm_clangd_*` MCP tools in this repository.

## Input Path Contract (AI-first tools)
Most clangd AI-first tools now require `filePath` (not `uri`).

Accepted `filePath` formats:
- Workspace-prefixed path: `UE5/Engine/Source/...` or `CthulhuGame/Source/...`
- Absolute path: `G:/UE_Folder/...` or `G:\UE_Folder\...`

Rejected format:
- `file:///...` URI

## Output Contract (AI-first tools)
AI-first tools return summary text blocks:
1. `counts ...`
2. `---`
3. Repeated entries:
- `<path>#<lineOrRange>`
- `<summary line>`
- `---`

Path rendering:
- Workspace file: `WorkspaceName/...#line` or `WorkspaceName/...#start-end`
- External file: absolute path with `/` separators
- Most AI-first tools also return `structuredContent` with equivalent semantic fields.

## Default-exposed clangd tools
- `lm_clangd_status`
- `lm_clangd_switchSourceHeader`
- `lm_clangd_ast`
- `lm_clangd_typeHierarchy`
- `lm_clangd_symbolSearch`
- `lm_clangd_symbolBundle`
- `lm_clangd_symbolInfo`
- `lm_clangd_symbolReferences`
- `lm_clangd_symbolImplementations`
- `lm_clangd_callHierarchy`
- `lm_clangd_lspRequest` (when passthrough is enabled)

`lm_clangd_typeHierarchyResolve` is removed.

---

## Tool: lm_clangd_status
Description:
- Get clangd extension and client status for diagnostics.

Input schema:
```json
{
  "type": "object",
  "properties": {}
}
```

Output:
- JSON text payload (status fields), unchanged.

---

## Tool: lm_clangd_switchSourceHeader
Description:
- Resolve paired header/source file.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" }
  },
  "required": ["filePath"]
}
```

Output:
- AI summary text with source and paired file path.

---

## Tool: lm_clangd_ast
Description:
- Query AST for a selected range.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "range": {
      "type": "object",
      "properties": {
        "start": {
          "type": "object",
          "properties": {
            "line": { "type": "number" },
            "character": { "type": "number" }
          },
          "required": ["line", "character"]
        },
        "end": {
          "type": "object",
          "properties": {
            "line": { "type": "number" },
            "character": { "type": "number" }
          },
          "required": ["line", "character"]
        }
      },
      "required": ["start", "end"]
    }
  },
  "required": ["filePath", "range"]
}
```

Output:
- AI summary text + AST JSON text section.

---

## Tool: lm_clangd_typeHierarchy
Description:
- Summarize class/struct type hierarchy with bounded depth/breadth.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "position": {
      "type": "object",
      "properties": {
        "line": { "type": "number" },
        "character": { "type": "number" }
      },
      "required": ["line", "character"]
    },
    "maxSuperDepth": { "type": "number" },
    "maxSubDepth": { "type": "number" },
    "maxSubBreadth": { "type": "number" }
  },
  "required": ["filePath", "position"]
}
```

Output:
- AI summary text with sections: `ROOT`, `SUPERS`, `DERIVED`.
- `SOURCE` section emits each entry in this order:
- `type <Name>`
- `preview: <single-line source preview>`
- `path: <path>#<lineOrRange>`
- `SOURCE` entries are separated by `---`.
- `structuredContent.sourceByClass.<TypeName>` includes:
- `filePath`, `startLine`, `endLine`, `summaryPath`, `preview`

---

## Tool: lm_clangd_symbolSearch
Description:
- Search symbols by exact name or regex.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "matchMode": { "type": "string", "enum": ["exact", "regex"] },
    "kinds": { "type": "array", "items": { "type": "string" } },
    "scopePath": { "type": "string" },
    "limit": { "type": "number" }
  },
  "required": ["query"]
}
```

Output:
- AI summary text entries for matched symbols.
- Each summary entry includes full signature text by default: `<kind> <name> (<container>) | signature: <...>`.
- `structuredContent.entries[]` includes:
- `signature: string | null`
- `signatureSource: "signatureHelp" | "hover" | "definitionLine" | "none"`

---

## Tool: lm_clangd_symbolBundle
Description:
- Aggregate symbol search/info/references/implementations/call hierarchy in one call.
- Use either `query` mode or `filePath + position` mode.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "matchMode": { "type": "string", "enum": ["exact", "regex"] },
    "filePath": { "type": "string" },
    "position": {
      "type": "object",
      "properties": {
        "line": { "type": "number" },
        "character": { "type": "number" }
      },
      "required": ["line", "character"]
    },
    "kinds": { "type": "array", "items": { "type": "string" } },
    "scopePath": { "type": "string" },
    "candidateLimit": { "type": "number" },
    "candidateIndex": { "type": "number" },
    "includeDeclaration": { "type": "boolean" },
    "referencesLimit": { "type": "number" },
    "implementationsLimit": { "type": "number" },
    "includeSnippet": { "type": "boolean" },
    "snippetMaxLines": { "type": "number" },
    "callDirection": { "type": "string", "enum": ["incoming", "outgoing", "both"] },
    "callMaxDepth": { "type": "number" },
    "callMaxBreadth": { "type": "number" }
  }
}
```

Output:
- AI summary text with sections: `TARGET`, `CANDIDATES`, `SYMBOL_INFO`, `REFERENCES_TOP`, `IMPLEMENTATIONS_TOP`, `CALLS_INCOMING`, `CALLS_OUTGOING`.
- `CANDIDATES` section includes signature text from symbol search results.
- `structuredContent` includes `target`, `candidates`(with signature fields), `symbolInfo`, `references`, `implementations`, and `callHierarchy`.

---

## Tool: lm_clangd_symbolInfo
Description:
- Get definition/declaration/hover/signature/snippet summary at position.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "position": {
      "type": "object",
      "properties": {
        "line": { "type": "number" },
        "character": { "type": "number" }
      },
      "required": ["line", "character"]
    },
    "includeSnippet": { "type": "boolean" },
    "snippetMaxLines": { "type": "number" }
  },
  "required": ["filePath", "position"]
}
```

Output:
- AI summary text with `HOVER`, `SIGNATURE`, optional `SNIPPET` sections.
- `SNIPPET` source excludes generated files by default: `*.generated.h`, `*.gen.cpp`.
- `structuredContent` fields include:
- `snippetSource: "definition" | "declaration" | "none"`
- `snippetFilteredGenerated: boolean`

---

## Tool: lm_clangd_symbolReferences
Description:
- List references for symbol at position.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "position": {
      "type": "object",
      "properties": {
        "line": { "type": "number" },
        "character": { "type": "number" }
      },
      "required": ["line", "character"]
    },
    "includeDeclaration": { "type": "boolean" },
    "limit": { "type": "number" }
  },
  "required": ["filePath", "position"]
}
```

Output:
- AI summary text entries for references.

---

## Tool: lm_clangd_symbolImplementations
Description:
- List implementation locations for symbol at position.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "position": {
      "type": "object",
      "properties": {
        "line": { "type": "number" },
        "character": { "type": "number" }
      },
      "required": ["line", "character"]
    },
    "limit": { "type": "number" }
  },
  "required": ["filePath", "position"]
}
```

Output:
- AI summary text entries for implementation points.

---

## Tool: lm_clangd_callHierarchy
Description:
- Get incoming/outgoing call hierarchy summary at position.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "position": {
      "type": "object",
      "properties": {
        "line": { "type": "number" },
        "character": { "type": "number" }
      },
      "required": ["line", "character"]
    },
    "direction": { "type": "string", "enum": ["incoming", "outgoing", "both"] },
    "maxDepth": { "type": "number" },
    "maxBreadth": { "type": "number" }
  },
  "required": ["filePath", "position"]
}
```

Output:
- AI summary text with `ROOT`, `INCOMING`, `OUTGOING` sections.

---

## Tool: lm_clangd_lspRequest
Description:
- Call allowed read-only LSP methods.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "method": { "type": "string" },
    "params": { "type": "object" },
    "timeoutMs": { "type": "number" }
  },
  "required": ["method"]
}
```

Output:
- JSON text payload (method + result).

## Notes
- Input/output position semantics exposed to users are 1-based.
- `lm_clangd_lspRequest` remains an advanced fallback path.
