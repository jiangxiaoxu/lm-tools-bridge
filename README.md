# LM Tools Bridge

[English](#english) | [中文](#中文)

## English

### Overview
LM Tools Bridge is a VS Code extension that exposes LM tools through MCP HTTP.
It uses a Manager endpoint as a stable entry, then routes to workspace MCP servers.

### Quick Start
1. Start service in VS Code: `LM Tools Bridge: Start Server`.
2. Connect your MCP client to Manager: `http://127.0.0.1:47100/mcp`.
3. Call handshake tool `lmToolsBridge.requestWorkspaceMCPServer` with `{ "cwd": "<project path>" }`.
4. Call tools via `lmToolsBridge.callTool` or standard `tools/call`.

### Endpoints
- Manager MCP: `http://127.0.0.1:47100/mcp`
- Manager status: `http://127.0.0.1:47100/mcp/status`
- Manager log: `http://127.0.0.1:47100/mcp/log`
- Workspace MCP (dynamic): `http://127.0.0.1:<runtime-port>/mcp`

### Core Behavior
- Always connect clients to Manager, not workspace runtime ports.
- Handshake is required before calling bridged workspace tools.
- If `Mcp-Session-Id` is stale, run handshake again with current session header.
- `roots/list` is manager-initiated when client declares `capabilities.roots`.

### Built-in Tool Summary

#### Search
- `lm_findFiles`: VS Code workspace file search (ripgrep backend).
- `lm_findTextInFiles`: VS Code workspace text search (ripgrep backend).
- Default policy: both are exposed by default, but not enabled by default.

#### Diagnostics
- `lm_getDiagnostics` reads from `vscode.languages.getDiagnostics`.
- Supports `filePaths`, `severities`, and `maxResults` (default `100`).
- Severity defaults to `error` + `warning`.

#### Qgrep
- `lm_qgrepGetStatus`: qgrep binary/workspace/index readiness snapshot.
- `lm_qgrepSearchText`: regex text search via bundled `bin/qgrep.exe`.
- `lm_qgrepSearchFiles`: qgrep files modes `fp`/`fn`/`fs`/`ff`.
- `lm_qgrepSearchFiles` does not support `searchPath`.
- `lm_qgrepSearchText` and `lm_qgrepSearchFiles` auto-init all current workspaces and wait until ready (timeout `150s`).
- Startup refresh for already initialized workspaces now syncs extension-managed `workspace.cfg` blocks before `qgrep update`.
- Managed blocks in `workspace.cfg` sync on init/rebuild/startup refresh/search.exclude changes:
  - Unreal include block: `*.ush`, `*.usf`, `*.ini`
  - PowerShell include block: `*.ps1`
  - Managed excludes from `search.exclude=true` + fixed excludes: `.git`, `Intermediate`, `DerivedDataCache`, `Saved`, `.vs`, `.vscode`

#### Tasks And Debug
- `lm_tasks_runBuild`, `lm_tasks_runTest`
- `lm_debug_listLaunchConfigs`, `lm_debug_start`
- Default policy: exposed by default, not enabled by default.


### Commands
- `lm-tools-bridge.start`
- `lm-tools-bridge.stop`
- `lm-tools-bridge.configureExposure`
- `lm-tools-bridge.configureEnabled`
- `lm-tools-bridge.statusMenu`
- `lm-tools-bridge.openHelp`
- `lm-tools-bridge.qgrepInitAllWorkspaces`
- `lm-tools-bridge.qgrepRebuildIndexes`
- `lm-tools-bridge.qgrepStopAndClearIndexes`

### Key Settings
- `lmToolsBridge.server.autoStart`
- `lmToolsBridge.server.port`
- `lmToolsBridge.manager.httpPort`
- `lmToolsBridge.useWorkspaceSettings`
- `lmToolsBridge.tools.exposedDelta`
- `lmToolsBridge.tools.unexposedDelta`
- `lmToolsBridge.tools.enabledDelta`
- `lmToolsBridge.tools.disabledDelta`
- `lmToolsBridge.tools.groupingRules`
- `lmToolsBridge.tools.schemaDefaults`
- `lmToolsBridge.debug`

### Logs
Open VS Code Output panel and select:
- `LM Tools Bridge`
- `lm-tools-bridge-tools`
- `lm-tools-bridge-qgrep`

### Troubleshooting
- `workspace not set` or `Unknown Mcp-Session-Id`: rerun handshake.
- `workspace not matched`: ensure `cwd` is inside target workspace.
- qgrep waits too long: check `lm_qgrepGetStatus`.
- `Tool not found or disabled`: ensure tool is both exposed and enabled.

### Change History
See `CHANGELOG.md`.

---

## 中文

### 概览
LM Tools Bridge 是一个 VS Code 扩展,用于通过 MCP HTTP 暴露 LM tools.
它使用 Manager 作为稳定入口,再把请求路由到对应 workspace 的 MCP server.

### 快速开始
1. 在 VS Code 里执行 `LM Tools Bridge: Start Server`.
2. MCP 客户端连接 Manager: `http://127.0.0.1:47100/mcp`.
3. 先调用握手工具 `lmToolsBridge.requestWorkspaceMCPServer`,参数 `{ "cwd": "<project path>" }`.
4. 然后通过 `lmToolsBridge.callTool` 或标准 `tools/call` 调用工具.

### 端点
- Manager MCP: `http://127.0.0.1:47100/mcp`
- Manager status: `http://127.0.0.1:47100/mcp/status`
- Manager log: `http://127.0.0.1:47100/mcp/log`
- Workspace MCP(动态端口): `http://127.0.0.1:<runtime-port>/mcp`

### 核心行为
- 客户端应始终连接 Manager,不要直连 workspace 动态端口.
- 调用 workspace 桥接工具前,必须先握手.
- `Mcp-Session-Id` 过期时,使用当前 session 头重新握手.
- 若客户端在 `initialize` 声明 `capabilities.roots`,manager 会主动发起 `roots/list`.

### 内置工具摘要

#### 搜索
- `lm_findFiles`: 使用 VS Code workspace 文件搜索(后端 ripgrep).
- `lm_findTextInFiles`: 使用 VS Code workspace 文本搜索(后端 ripgrep).
- 默认策略: 两者默认 exposed,默认不 enabled.

#### 诊断
- `lm_getDiagnostics` 基于 `vscode.languages.getDiagnostics`.
- 支持 `filePaths`,`severities`,`maxResults`(默认 `100`).
- `severities` 未传时默认 `error` + `warning`.

#### Qgrep
- `lm_qgrepGetStatus`: 返回 qgrep binary/workspace/index 就绪快照.
- `lm_qgrepSearchText`: 通过内置 `bin/qgrep.exe` 做 regex 文本搜索.
- `lm_qgrepSearchFiles`: 使用 qgrep 文件模式 `fp`/`fn`/`fs`/`ff`.
- `lm_qgrepSearchFiles` 不支持 `searchPath`.
- `lm_qgrepSearchText` 和 `lm_qgrepSearchFiles` 会按需自动初始化当前全部 workspace,并等待到就绪(超时 `150s`).
- 对已初始化 workspace,扩展启动后的后台刷新会先同步插件受管 `workspace.cfg` 区块,再执行 `qgrep update`.
- `workspace.cfg` 受管区块会在 init/rebuild/启动刷新/search.exclude 变更时同步:
  - Unreal include: `*.ush`,`*.usf`,`*.ini`
  - PowerShell include: `*.ps1`
  - `search.exclude=true` 转换的排除规则 + 固定排除: `.git`,`Intermediate`,`DerivedDataCache`,`Saved`,`.vs`,`.vscode`

#### Tasks 与 Debug
- `lm_tasks_runBuild`,`lm_tasks_runTest`
- `lm_debug_listLaunchConfigs`,`lm_debug_start`
- 默认策略: 这些工具默认 exposed,默认不 enabled.


### 命令
- `lm-tools-bridge.start`
- `lm-tools-bridge.stop`
- `lm-tools-bridge.configureExposure`
- `lm-tools-bridge.configureEnabled`
- `lm-tools-bridge.statusMenu`
- `lm-tools-bridge.openHelp`
- `lm-tools-bridge.qgrepInitAllWorkspaces`
- `lm-tools-bridge.qgrepRebuildIndexes`
- `lm-tools-bridge.qgrepStopAndClearIndexes`

### 关键设置
- `lmToolsBridge.server.autoStart`
- `lmToolsBridge.server.port`
- `lmToolsBridge.manager.httpPort`
- `lmToolsBridge.useWorkspaceSettings`
- `lmToolsBridge.tools.exposedDelta`
- `lmToolsBridge.tools.unexposedDelta`
- `lmToolsBridge.tools.enabledDelta`
- `lmToolsBridge.tools.disabledDelta`
- `lmToolsBridge.tools.groupingRules`
- `lmToolsBridge.tools.schemaDefaults`
- `lmToolsBridge.debug`

### 日志
打开 VS Code Output 面板,可查看:
- `LM Tools Bridge`
- `lm-tools-bridge-tools`
- `lm-tools-bridge-qgrep`

### 故障排查
- `workspace not set` 或 `Unknown Mcp-Session-Id`: 重新握手.
- `workspace not matched`: 检查 `cwd` 是否在目标 workspace 内.
- qgrep 等待过久: 先看 `lm_qgrepGetStatus`.
- `Tool not found or disabled`: 确认工具同时处于 exposed 与 enabled.

### 变更历史
参见 `CHANGELOG.md`.
