# LM Tools Bridge Proxy

Stdio MCP proxy that resolves the active VS Code instance via the LM Tools Bridge Manager (Windows Named Pipe).

## Usage (Codex)

```
command = "npx"
args = ["-y", "@jiangxiaoxu/lm-tools-bridge-proxy"]
```

The proxy uses the current working directory (`cwd`) to resolve the VS Code instance.

## Handshake (required)

Codex does not pass `cwd` into `npx` MCP services, so the proxy requires an explicit workspace handshake before it forwards MCP requests.

1. Call `lmToolsBridgeProxy.requestWorkspaceMCPServer` with `params.cwd`.
2. Wait for `ok: true` and a resolved target.

Until `lmToolsBridgeProxy.requestWorkspaceMCPServer` succeeds, the proxy rejects all MCP requests (including `roots/list`) with a workspace-not-ready error.

If the target MCP goes offline, the proxy marks itself disconnected and attempts auto-reconnect every second. `lmTools/status` returns `offlineDurationSec` to show how long it has been offline.

The proxy always exposes a minimal MCP resource (`lm-tools-bridge-proxy://handshake`) via `resources/list`, and it is pinned to the top of the list. It also returns `lmToolsBridgeProxy.requestWorkspaceMCPServer` from `tools/list` before handshake so clients can discover the exact method name.

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
