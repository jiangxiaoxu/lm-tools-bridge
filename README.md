# LM Tools Bridge

LM Tools Bridge is a VS Code extension that exposes workspace tools over MCP.
External MCP clients connect to a local stdio manager, bind to a target VS Code workspace, and then use the bridged tools.

[English](#english) | [中文](#中文)

## English

### What It Is
LM Tools Bridge exposes VS Code workspace tools to external MCP clients.

- Windows only
- Designed for terminal MCP clients and agent workflows

### Requirements
- VS Code
- Node.js on `PATH`

If `node` is missing, the extension shows a startup warning with `Install with winget` and `Download Node.js`.

### Quick Start
1. Install the extension in VS Code.
2. Open your project folder or `.code-workspace`.
3. Let the extension activate once.
4. The extension will:
   - auto-start the local MCP server
   - sync `stdioManager.js` to `%LOCALAPPDATA%\lm-tools-bridge\stdioManager.js`

### MCP Client Example
Codex example:

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

The PowerShell wrapper is recommended because many MCP clients do not expand environment variables inside raw `args`.

Optional for Codex app: the `vscode-tools` skill works well with this extension.

### Basic Usage Flow
1. Start one stdio manager for the client session.
2. Call `lmToolsBridge.requestWorkspaceMCPServer`.
3. Set `cwd` to either:
   - the project path
   - the `.code-workspace` path
4. After handshake succeeds, use bridged workspace tools from `tools/list`, or call `lmToolsBridge.callTool`.

Notes:
- Handshake is required before using bridged workspace tools.
- VS Code-sourced workspace tools are exposed with an `lm_` prefix. For example, `copilot_searchCodebase` is exposed as `lm_copilot_searchCodebase`.
- If a tool argument uses `pathScope`, read `lm-tools://spec/pathScope` after handshake.

### Troubleshooting
- `node` is missing: install Node.js, restart VS Code, and retry.
- `Untitled multi-root workspace is not supported`: save it as a real `.code-workspace` file first.

## 中文

### 是什么
LM Tools Bridge 是一个 VS Code 扩展,用于通过 MCP 向外部客户端暴露当前 workspace 的工具能力.

- 仅支持 Windows
- 面向终端 MCP 客户端和 agent 工作流

### 依赖
- VS Code
- 系统 `PATH` 上可直接执行 `node`

如果缺少 `node`,扩展启动时会弹出提示,可直接选择 `Install with winget` 或 `Download Node.js`.

### 快速开始
1. 在 VS Code 中安装扩展.
2. 打开项目目录或 `.code-workspace`.
3. 让扩展至少激活一次.
4. 扩展会自动:
   - 启动本地 MCP server
   - 将 `stdioManager.js` 同步到 `%LOCALAPPDATA%\lm-tools-bridge\stdioManager.js`

### MCP 客户端示例
下面是 Codex 配置示例:

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

可选: 如果你在用 Codex app,`vscode-tools` skill 和这个扩展配合会更顺手.

### 基本使用流程
1. 为当前客户端会话启动一个 stdio manager.
2. 调用 `lmToolsBridge.requestWorkspaceMCPServer`.
3. `cwd` 可以传:
   - 项目路径
   - `.code-workspace` 路径
4. 握手成功后,通过 `tools/list` 使用桥接后的 workspace tools,或继续调用 `lmToolsBridge.callTool`.

说明:
- 使用桥接 workspace tools 之前,必须先完成握手.
- 来自 VS Code 的 workspace tool 对外统一带 `lm_` 前缀. 例如 `copilot_searchCodebase` 会暴露为 `lm_copilot_searchCodebase`.
- 如果某个工具参数使用了 `pathScope`,请在握手后读取 `lm-tools://spec/pathScope`.

### 故障排查
- 缺少 `node`: 安装 Node.js,重启 VS Code 后再试.
- `Untitled multi-root workspace is not supported`: 先把当前多根 workspace 保存成真实 `.code-workspace` 文件.
