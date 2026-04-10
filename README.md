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

### Basic Usage Flow
1. Start one stdio manager for the client session.
2. Read `lm-tools://guide` once.
3. Call `lmToolsBridge.bindWorkspace`.
4. Set `cwd` to an absolute path for either:
   - the project path
   - the `.code-workspace` path
   - relative paths are invalid
5. After bind succeeds, use bridged workspace tools from `tools/list`, or call `lmToolsBridge.callBridgedTool`.

Notes:
- Handshake is required before using bridged workspace tools.
- `lmToolsBridge.bindWorkspace` is the entrypoint when the task calls for vscode-tools-like workspace search, code navigation, diagnostics, or VS Code IDE actions, or explicitly includes phrases like `vscode-tools` or `use vscode`.
- Read `lm-tools://guide` for the detailed workflow, routing, and fallback guide. It is guide-only and does not embed live status snapshots or example payloads.
- VS Code-sourced workspace tools are exposed with an `lm_` prefix. For example, `copilot_searchCodebase` is exposed as `lm_copilot_searchCodebase`.
- `lm_formatFiles` is exposed by default but disabled by default. It formats the files selected by `pathScope`, applies edits, and saves changed files after you enable it.
- Handshake `discovery.bridgedTools` returns tool names only. Read `lm-tools://tool/{name}` for the tool description and `inputSchema`.
- Read `lm-tools://tool/{name}` before the first bridged tool call, then build arguments from its `inputSchema`.
- The direct `lmToolsBridge.callBridgedTool` helper is documented in `lm-tools://guide`; the names-only discovery resource is `lm-tools://tool-names`.
- If a tool argument uses `pathScope`, read `lm-tools://spec/pathScope` after bind.

### Workspace Settings
- When `lmToolsBridge.useWorkspaceSettings=true`, the extension writes its own config through the current workspace scope.
- In a saved `.code-workspace`, settings are written to the workspace file.
- In a single-folder workspace, settings are written to `.vscode/settings.json`.
- Reads keep the existing fallback behavior: single-folder workspaces prefer `WorkspaceFolder` values and fall back to `Workspace` values when needed.

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


### 基本使用流程
1. 为当前客户端会话启动一个 stdio manager.
2. 先读取一次 `lm-tools://guide`.
3. 调用 `lmToolsBridge.bindWorkspace`.
4. `cwd` 需要传绝对路径,可以是:
   - 项目路径
   - `.code-workspace` 路径
   - 相对路径无效
5. 绑定成功后,通过 `tools/list` 使用桥接后的 workspace tools,或继续调用 `lmToolsBridge.callBridgedTool`.

说明:
- 使用桥接 workspace tools 之前,必须先完成握手.
- 当任务需要类似 vscode-tools 的 workspace search、code navigation、diagnostics 或 VS Code IDE actions,或明确说出 `vscode-tools` 或 `use vscode` 时,应从 `lmToolsBridge.bindWorkspace` 开始.
- 读取 `lm-tools://guide`,里面包含更详细的 workflow、routing 和 fallback 指南,不会内嵌 live status snapshot 或 example payload.
- 来自 VS Code 的 workspace tool 对外统一带 `lm_` 前缀. 例如 `copilot_searchCodebase` 会暴露为 `lm_copilot_searchCodebase`.
- `lm_formatFiles` 默认已暴露但默认禁用,启用后会按 `pathScope` 选择文件,执行 format 并保存变更.
- 握手里的 `discovery.bridgedTools` 只返回 tool name. 需要 tool description 和 `inputSchema` 时,请读取 `lm-tools://tool/{name}`.
- 首次调用桥接 tool 之前,先读取 `lm-tools://tool/{name}`,再根据其中的 `inputSchema` 组装参数.
- `lmToolsBridge.callBridgedTool` 的详细调用和 fallback 规则已经并入 `lm-tools://guide`; names-only discovery resource 是 `lm-tools://tool-names`.
- 如果某个工具参数使用了 `pathScope`,请在绑定后读取 `lm-tools://spec/pathScope`.

### 工作区设置
- 当 `lmToolsBridge.useWorkspaceSettings=true` 时,扩展会按当前 workspace scope 写入自己的配置.
- 在已保存的 `.code-workspace` 中,配置写入 workspace 文件本身.
- 在单文件夹 workspace 中,配置写入 `.vscode/settings.json`.
- 读取时保留现有 fallback: 单文件夹 workspace 优先读取 `WorkspaceFolder`,缺失时回退到 `Workspace`.

### 故障排查
- 缺少 `node`: 安装 Node.js,重启 VS Code 后再试.
- `Untitled multi-root workspace is not supported`: 先把当前多根 workspace 保存成真实 `.code-workspace` 文件.
