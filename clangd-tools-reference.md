# clangd Tools Reference

## Scope
This reference documents clangd MCP tools that are currently exposed by default when:

- `lmToolsBridge.clangd.enabled=true`
- and, for passthrough, `lmToolsBridge.clangd.enablePassthrough=true`

Current default-exposed tools:

- `lm_clangd_status`
- `lm_clangd_switchSourceHeader`
- `lm_clangd_ast`
- `lm_clangd_typeHierarchy`
- `lm_clangd_typeHierarchyResolve`
- `lm_clangd_lspRequest`

## Global MCP Output Envelope

All tools here are custom tools and return a logical payload encoded as JSON text.
The MCP outer envelope depends on `lmToolsBridge.tools.responseFormat`:

- `text` (default):
```json
{
  "content": [
    {
      "type": "text",
      "text": "{...logicalPayloadJson...}"
    }
  ]
}
```

- `structured`:
```json
{
  "content": [],
  "structuredContent": {
    "blocks": [
      {
        "type": "text",
        "text": "{...logicalPayloadJson...}"
      }
    ]
  }
}
```

- `both`:
```json
{
  "content": [
    {
      "type": "text",
      "text": "{...logicalPayloadJson...}"
    }
  ],
  "structuredContent": {
    "blocks": [
      {
        "type": "text",
        "text": "{...logicalPayloadJson...}"
      }
    ]
  }
}
```

## Tool: lm_clangd_status

Description:
`Get clangd extension and client status for MCP diagnostics.`

Input schema:
```json
{
  "type": "object",
  "properties": {}
}
```

Logical output schema:
```json
{
  "type": "object",
  "properties": {
    "clangdMcpEnabled": { "type": "boolean" },
    "extensionInstalled": { "type": "boolean" },
    "extensionActive": { "type": "boolean" },
    "apiAvailable": { "type": "boolean" },
    "clientAvailable": { "type": "boolean" },
    "clientState": { "type": "string" },
    "clangdEnableSetting": { "type": "boolean" },
    "workspaceTrusted": { "type": "boolean" },
    "autoStartOnInvoke": { "type": "boolean" },
    "requestTimeoutMs": { "type": "number" },
    "passthroughEnabled": { "type": "boolean" },
    "allowedPassthroughMethods": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": [
    "clangdMcpEnabled",
    "extensionInstalled",
    "extensionActive",
    "apiAvailable",
    "clientAvailable",
    "clientState",
    "clangdEnableSetting",
    "workspaceTrusted",
    "autoStartOnInvoke",
    "requestTimeoutMs",
    "passthroughEnabled",
    "allowedPassthroughMethods"
  ]
}
```

## Tool: lm_clangd_switchSourceHeader

Description:
`Resolve the paired header/source file using clangd textDocument/switchSourceHeader.`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "uri": {
      "type": "string",
      "description": "File URI, for example: file:///path/to/file.cpp"
    }
  },
  "required": ["uri"]
}
```

Logical output schema:
```json
{
  "type": "object",
  "properties": {
    "uri": { "type": "string" },
    "sourceUri": { "type": ["string", "null"] },
    "found": { "type": "boolean" }
  },
  "required": ["uri", "sourceUri", "found"]
}
```

## Tool: lm_clangd_ast

Description:
`Query clangd textDocument/ast for the selected source range.`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "uri": {
      "type": "string",
      "description": "File URI, for example: file:///path/to/file.cpp"
    },
    "range": {
      "type": "object",
      "properties": {
        "start": {
          "type": "object",
          "properties": {
            "line": { "type": "number", "description": "1-based line index." },
            "character": { "type": "number", "description": "1-based character index." }
          },
          "required": ["line", "character"]
        },
        "end": {
          "type": "object",
          "properties": {
            "line": { "type": "number", "description": "1-based line index." },
            "character": { "type": "number", "description": "1-based character index." }
          },
          "required": ["line", "character"]
        }
      },
      "required": ["start", "end"]
    }
  },
  "required": ["uri", "range"]
}
```

Logical output schema:
```json
{
  "type": "object",
  "properties": {
    "uri": { "type": "string" },
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
    },
    "ast": {
      "anyOf": [
        {
          "type": "object",
          "description": "clangd AST node tree (implementation-defined)."
        },
        { "type": "null" }
      ]
    }
  },
  "required": ["uri", "range", "ast"]
}
```

## Tool: lm_clangd_typeHierarchy

Description:
`Query clangd textDocument/typeHierarchy at a given source position.`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "uri": {
      "type": "string",
      "description": "File URI, for example: file:///path/to/file.cpp"
    },
    "position": {
      "type": "object",
      "properties": {
        "line": { "type": "number", "description": "1-based line index." },
        "character": { "type": "number", "description": "1-based character index." }
      },
      "required": ["line", "character"]
    },
    "resolve": { "type": "number", "description": "Initial hierarchy resolve depth. Default is 5." },
    "direction": { "type": "number", "description": "0=children, 1=parents, 2=both. Default is 2." }
  },
  "required": ["uri", "position"]
}
```

Logical output schema:
```json
{
  "type": "object",
  "properties": {
    "uri": { "type": "string" },
    "position": {
      "type": "object",
      "properties": {
        "line": { "type": "number" },
        "character": { "type": "number" }
      },
      "required": ["line", "character"]
    },
    "resolve": { "type": "number" },
    "direction": { "type": "number", "enum": [0, 1, 2] },
    "item": {
      "anyOf": [
        {
          "type": "object",
          "description": "clangd type hierarchy item (implementation-defined)."
        },
        { "type": "null" }
      ]
    }
  },
  "required": ["uri", "position", "resolve", "direction", "item"]
}
```

## Tool: lm_clangd_typeHierarchyResolve

Description:
`Resolve additional clangd type hierarchy levels using typeHierarchy/resolve.`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "item": {
      "type": "object",
      "description": "Type hierarchy item returned from previous request."
    },
    "resolve": { "type": "number", "description": "Resolve depth. Default is 1." },
    "direction": { "type": "number", "description": "0=children, 1=parents. Default is 0." }
  },
  "required": ["item"]
}
```

Logical output schema:
```json
{
  "type": "object",
  "properties": {
    "resolve": { "type": "number" },
    "direction": { "type": "number", "enum": [0, 1, 2] },
    "item": {
      "anyOf": [
        {
          "type": "object",
          "description": "Resolved clangd type hierarchy item (implementation-defined)."
        },
        { "type": "null" }
      ]
    }
  },
  "required": ["resolve", "direction", "item"]
}
```

## Tool: lm_clangd_lspRequest

Description:
`Call an allowed clangd LSP request method.`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "method": { "type": "string", "description": "LSP method name." },
    "params": { "type": "object", "description": "Request params object using 1-based line/character positions." },
    "timeoutMs": { "type": "number", "description": "Optional per-call timeout in milliseconds." }
  },
  "required": ["method"]
}
```

Logical output schema:
```json
{
  "type": "object",
  "properties": {
    "method": { "type": "string" },
    "result": {
      "anyOf": [
        { "type": "object" },
        { "type": "array" },
        { "type": "string" },
        { "type": "number" },
        { "type": "boolean" },
        { "type": "null" }
      ]
    }
  },
  "required": ["method", "result"]
}
```

Allowed methods (effective default read-only set):

- `textDocument/hover`
- `textDocument/definition`
- `textDocument/declaration`
- `textDocument/typeDefinition`
- `textDocument/implementation`
- `textDocument/references`
- `textDocument/documentSymbol`
- `workspace/symbol`
- `textDocument/signatureHelp`
- `textDocument/switchSourceHeader`
- `textDocument/ast`
- `textDocument/typeHierarchy`
- `typeHierarchy/resolve`

## Notes

- All tool inputs that include `line`/`character` use 1-based indexing.
- All tool outputs that include `line`/`character` are normalized to 1-based indexing.
- `lm_clangd_memoryUsage` and `lm_clangd_inlayHints` are implemented in source but are currently pruned from default exposure.
- `output schema` in this document describes the logical payload encoded into tool text content.
