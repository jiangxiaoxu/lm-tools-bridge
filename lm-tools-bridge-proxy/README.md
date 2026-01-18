# LM Tools Bridge Proxy

Stdio MCP proxy that resolves the active VS Code instance via the LM Tools Bridge Manager (Windows Named Pipe).

## Usage (Codex)

```
command = "npx"
args = ["-y", "@jiangxiaoxu/lm-tools-bridge-proxy"]
```

The proxy uses the current working directory (`cwd`) to resolve the VS Code instance.

## Logging

Set `LM_TOOLS_BRIDGE_PROXY_LOG` to a file path to enable log output. If unset, the proxy emits no logs.

## Resolve test

```
node ./scripts/resolve-test.mjs --cwd <workspace-path>
```

## Development

```
npm install
npm run build
```
