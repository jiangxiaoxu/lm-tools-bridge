# LM Tools Bridge

[English](#english) | [中文](#中文)

## English

### Overview
LM Tools Bridge is a VS Code extension that exposes workspace tools through MCP.
External MCP clients connect to a local stdio manager, then bind to the target VS Code workspace instance.

This extension currently supports Windows only.

### Prerequisites
- VS Code
- Node.js available on `PATH`

If Node.js is missing, the extension shows a startup warning with `Install with winget` and `Download Node.js`.

### Install And First Launch
1. Install the extension in VS Code.
2. Open the target folder or `.code-workspace` in VS Code.
3. Let the extension activate once so it syncs `stdioManager.js` to `%LOCALAPPDATA%\lm-tools-bridge\stdioManager.js`.
4. The MCP server starts automatically when the extension activates.

### Codex MCP Config
Recommended Codex config:

```toml
[mcp_servers.lm_tools_bridge]
command = "powershell.exe"
args = [
  "-NoProfile",
  "-Command",
  "node \"$env:LOCALAPPDATA\\lm-tools-bridge\\stdioManager.js\""
]
enabled = true
```

The PowerShell wrapper is recommended because many MCP clients do not expand environment variables inside raw args.

### Basic Usage
1. Start one stdio manager per client session.
2. Call `lmToolsBridge.requestWorkspaceMCPServer`.
3. Pass `cwd` as either:
   - the target project path
   - the target `.code-workspace` file path
4. After handshake succeeds, use the bridged tools from `tools/list`, or continue using `lmToolsBridge.callTool`.

Notes:
- Handshake is required before calling bridged workspace tools.
- If the target VS Code instance does not exist yet, handshake will try to start the matching VS Code instance first.
- On Windows, handshake resolves the launch target from `cwd` like this:
  - if `cwd` is a `.code-workspace` file, use it directly
  - if `cwd` is a file, start from its parent directory
  - otherwise walk upward level by level, checking `.code-workspace`, then `.vscode`, then `.git`
  - if nothing matches at every level, use the current directory
- If the bound VS Code instance closes later, rerun handshake. It will not auto-restart after binding.

### Troubleshooting
- `node` is missing: install Node.js, restart VS Code, then retry.
- `Untitled multi-root workspace is not supported`: save it as a real `.code-workspace` file first.

### More Information
See `CHANGELOG.md` for release history.

---

## 中文

### 概览
LM Tools Bridge 是一个 VS Code 扩展,用于通过 MCP 暴露当前 workspace 的工具能力.
外部 MCP 客户端先连接本地 stdio manager,再绑定到目标 VS Code workspace 实例.

当前只支持 Windows.

### 前置依赖
- VS Code
- 系统 `PATH` 上可以直接执行 `node`

如果缺少 Node.js,扩展启动时会弹出提示,可直接选择 `Install with winget` 或 `Download Node.js`.

### 安装与首次启动
1. 在 VS Code 中安装本扩展.
2. 打开目标文件夹或目标 `.code-workspace`.
3. 先让扩展激活一次,这样会把 `stdioManager.js` 同步到 `%LOCALAPPDATA%\lm-tools-bridge\stdioManager.js`.
4. 扩展激活后,MCP server 会自动启动.

### Codex MCP 配置
推荐在 Codex 中这样配置:

```toml
[mcp_servers.lm_tools_bridge]
command = "powershell.exe"
args = [
  "-NoProfile",
  "-Command",
  "node \"$env:LOCALAPPDATA\\lm-tools-bridge\\stdioManager.js\""
]
enabled = true
```

推荐包一层 PowerShell,因为很多 MCP 客户端不会自动展开原始 `args` 里的环境变量.

### 基本使用
1. 每个客户端会话启动一个 stdio manager.
2. 调用 `lmToolsBridge.requestWorkspaceMCPServer`.
3. `cwd` 传以下任意一种:
   - 目标项目路径
   - 目标 `.code-workspace` 文件路径
4. 握手成功后,再使用 `tools/list` 里的桥接工具,或者继续调用 `lmToolsBridge.callTool`.

说明:
- 调用桥接 workspace 工具前,必须先握手.
- 如果目标 VS Code 实例还不存在,握手阶段会先尝试拉起匹配的 VS Code 实例.
- 在 Windows 上,握手会按下面的规则从 `cwd` 解析启动目标:
  - 如果 `cwd` 本身就是 `.code-workspace` 文件,直接使用它
  - 如果 `cwd` 是文件,从它的父目录开始
  - 之后按层级逐级向上查找,每一层都先查 `.code-workspace`,再查 `.vscode`,再查 `.git`
  - 如果所有层级都没有命中,就使用当前目录
- 如果绑定后的 VS Code 实例后续关闭,需要重新握手,不会自动重启.

### 故障排查
- 缺少 `node`: 先安装 Node.js,重启 VS Code 后再试.
- `Untitled multi-root workspace is not supported`: 先把当前多根 workspace 保存成真实 `.code-workspace` 文件.

### 更多信息
版本历史见 `CHANGELOG.md`.
