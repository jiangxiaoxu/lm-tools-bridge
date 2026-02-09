# LM Tools Bridge

[English](#english) | [中文](#中文)

---

## English

### Overview
LM Tools Bridge is a VS Code extension that exposes LM tools through MCP HTTP.
It uses a built-in Manager to route requests to the correct workspace MCP server.

This README covers the current Manager-based version only.

### Quick Start
1. Start the extension server in VS Code with `LM Tools Bridge: Start Server` (or enable `lmToolsBridge.server.autoStart`).
2. In your MCP client, connect to Manager endpoint `http://127.0.0.1:47100/mcp` (or `http://127.0.0.1:<lmToolsBridge.manager.httpPort>/mcp`).
3. Before tool calls, run handshake `lmToolsBridge.requestWorkspaceMCPServer` with `{ "cwd": "<your project path>" }`.
4. After handshake, call `resources/list`, read `lm-tools://schema/{name}` for first-time tools, then call tools.

### Endpoints
- Manager MCP endpoint (client entry): `http://127.0.0.1:47100/mcp`
- Manager status endpoint (diagnostics): `http://127.0.0.1:47100/mcp/status`
- Workspace MCP endpoint (dynamic target): `http://127.0.0.1:<runtime-port>/mcp`

### Manager vs Workspace MCP Server
- Manager is the stable client-facing MCP endpoint.
- Workspace MCP server is hosted by a VS Code instance and can change across instances or restarts.
- Manager performs workspace matching by `cwd`, health checks, and request forwarding.
- For user stability, connect MCP clients to Manager, not directly to workspace MCP ports.

### How To Connect Your MCP Client
1. Configure MCP URL to `http://127.0.0.1:47100/mcp` (or custom manager port).
2. Send `initialize`, keep the returned `Mcp-Session-Id` header.
3. Call `lmToolsBridge.requestWorkspaceMCPServer` with `cwd`.
4. Use `lmToolsBridge.callTool` or standard `tools/call` after schema read.
5. If session header is lost/expired (`Missing Mcp-Session-Id` or `Unknown Mcp-Session-Id`), re-initialize and handshake again.

Example config:

```toml
[mcp_servers.lm_tools_bridge]
url = "http://127.0.0.1:47100/mcp"
```

### How Port Avoidance Works
- Preferred workspace port starts from `lmToolsBridge.server.port`.
- Manager `POST /allocate` tries to reserve a non-conflicting candidate port.
- Allocation considers active instance ports and short-term reservations, to reduce collisions between VS Code instances.
- When extension binds socket, if `EADDRINUSE` occurs, it auto-increments and retries (up to 50 attempts).
- If retries are exhausted, status bar shows `Port In Use`.
- Even if Manager is temporarily unavailable, extension still tries local incremental bind for availability.

User guidance:
- Do not hardcode workspace MCP runtime port in MCP clients.
- Always connect client to Manager `/mcp` and do handshake per workspace.

### Daily Usage
- `Configure Exposure Tools`: choose tools that can be selected.
- `Configure Enabled Tools`: choose active tools within exposed set.
- Built-in disabled tools are always blocked and never callable.
- Some default tools are policy-required exposure items.

### Troubleshooting
- `workspace not set`:
  - Run `lmToolsBridge.requestWorkspaceMCPServer` with `cwd` first.
- `workspace not matched`:
  - Check `cwd` points inside the target workspace folder.
- `resolved MCP server is offline`:
  - Ensure target VS Code instance and extension server are running.
  - Re-run handshake.
- Client stops working after port change:
  - Connect to Manager `/mcp` instead of old workspace runtime port.
- `Tool not found or disabled`:
  - Ensure the tool is both exposed and enabled.

### Tool Output Mapping
- LM tool `LanguageModelTextPart` is used as `content.text`.
- `content.text` is forwarded from `LanguageModelTextPart` only, without falling back to `LanguageModelDataPart`.
- LM tool `LanguageModelDataPart` with JSON mime type (`application/json`, `application/json; charset=utf-8`, or `*+json`) is parsed as JSON object and used as `structuredContent` when possible.
- If no JSON object is available for `structuredContent`, bridge falls back to `{ blocks: [...] }`.

### Clangd Tools (Optional)
Enable clangd MCP tools with:
- `lmToolsBridge.clangd.enabled`

Notes:
- AI-first tools now use `filePath` input instead of `uri`.
- `filePath` supports:
- workspace-prefixed path, for example `UE5/Engine/Source/...`
- absolute path, for example `G:/UE_Folder/...` or `G:\\UE_Folder\\...`
- `file:///...` URI input is rejected.
- AI-first outputs use summary text blocks:
- first line `counts ...`
- second line `---`
- then repeated `<path>#<lineOrRange>` + summary line entries with `---` separators
- AI-first clangd tools also return `structuredContent` with machine-stable fields:
- location fields use `absolutePath` (always) + `workspacePath` (nullable)
- line/character fields remain numeric 1-based fields, not `path#...` strings
- structured outputs avoid echoing raw input arguments
- `lm_clangd_symbolSearch` now includes full symbol signature by default in both text summary and `structuredContent`.
- `lm_clangd_symbolInfo` snippet source excludes generated files (`*.generated.h`, `*.gen.cpp`) by default.
- `lm_clangd_symbolInfo` now uses adaptive symbol-category output and includes `typeDefinition` for value-like symbols when meaningful.
- `lm_clangd_typeHierarchy` `SOURCE` section now emits `type -> preview -> path` to improve AI readability.
- `lm_clangd_typeHierarchy` `structuredContent.sourceByClass` includes `absolutePath/workspacePath/startLine/endLine/preview`.
- summary path format is `WorkspaceName/...#line` for workspace files, absolute path for external files.
- Default exposed clangd AI tools:
- `lm_clangd_status`
- `lm_clangd_switchSourceHeader`
- `lm_clangd_typeHierarchy`
- `lm_clangd_symbolSearch`
- `lm_clangd_symbolBundle`
- `lm_clangd_symbolInfo`
- `lm_clangd_symbolReferences`
- `lm_clangd_symbolImplementations`
- `lm_clangd_callHierarchy`
- `lm_clangd_lspRequest` is controlled by `lmToolsBridge.clangd.enablePassthrough` and `lmToolsBridge.clangd.allowedMethods`.
- With `lmToolsBridge.clangd.autoStartOnInvoke=true`, clangd can auto-start on first clangd tool invocation.
- `clangd.enable` is clangd extension setting, not an `lmToolsBridge.*` setting.

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
- `lmToolsBridge.tools.responseFormat`
- `lmToolsBridge.debug`

Recommendation:
- If you need to change connection port, adjust `lmToolsBridge.manager.httpPort` for clients first.

### Commands
- `lm-tools-bridge.start`
- `lm-tools-bridge.stop`
- `lm-tools-bridge.configureExposure`
- `lm-tools-bridge.configureEnabled`
- `lm-tools-bridge.statusMenu`
- `lm-tools-bridge.openHelp`

### Logs
Open Output panel and select `LM Tools Bridge`.

- `off`: status only
- `simple`: tool name, input, duration
- `detail`: includes full output

### Full Change History
See `CHANGELOG.md`.

---

## 中文

### 概览
LM Tools Bridge 是一个 VS Code 扩展,用于通过 MCP HTTP 暴露 LM tools.
它内置 Manager,用于把请求路由到正确的工作区 MCP server.

本 README 只覆盖当前 Manager 版本.

### 快速开始
1. 在 VS Code 执行 `LM Tools Bridge: Start Server` 启动服务(或开启 `lmToolsBridge.server.autoStart`).
2. 在 MCP 客户端连接 Manager 端点 `http://127.0.0.1:47100/mcp`(或 `http://127.0.0.1:<lmToolsBridge.manager.httpPort>/mcp`).
3. 调用工具前,先执行握手 `lmToolsBridge.requestWorkspaceMCPServer`,参数 `{ "cwd": "<你的项目路径>" }`.
4. 握手成功后,先调用 `resources/list`,首次使用某工具前读取 `lm-tools://schema/{name}`,再调用工具.

### 端点
- Manager MCP 端点(客户端入口): `http://127.0.0.1:47100/mcp`
- Manager 状态端点(诊断): `http://127.0.0.1:47100/mcp/status`
- 工作区 MCP 端点(动态目标): `http://127.0.0.1:<runtime-port>/mcp`

### Manager 与工作区 MCP Server 的关系
- Manager 是稳定的客户端 MCP 入口.
- 工作区 MCP server 由某个 VS Code 实例承载,会随实例或重启变化.
- Manager 会基于 `cwd` 做工作区匹配,健康检查,并转发请求.
- 为了稳定使用,客户端应连接 Manager,不要直接连工作区动态端口.

### 如何连接 MCP 客户端
1. 将 MCP URL 配置为 `http://127.0.0.1:47100/mcp`(或自定义 manager 端口).
2. 发送 `initialize`,保存返回的 `Mcp-Session-Id` 响应头.
3. 调用 `lmToolsBridge.requestWorkspaceMCPServer` 并传 `cwd`.
4. 读取 schema 后,用 `lmToolsBridge.callTool` 或标准 `tools/call` 调用工具.
5. 如果会话头丢失或过期(出现 `Missing Mcp-Session-Id` 或 `Unknown Mcp-Session-Id`),需要重新 initialize 和握手.

配置示例:

```toml
[mcp_servers.lm_tools_bridge]
url = "http://127.0.0.1:47100/mcp"
```

### 端口避让如何工作
- 工作区 MCP 偏好端口起点来自 `lmToolsBridge.server.port`.
- Manager 通过 `POST /allocate` 先分配一个尽量不冲突的候选端口.
- 分配时会考虑活跃实例端口和短期保留端口,减少多实例抢占.
- 扩展真正绑定端口时,若遇到 `EADDRINUSE`,会自动递增重试(最多 50 次).
- 超过重试上限后,状态栏会显示 `Port In Use`.
- 即使 Manager 暂时不可用,扩展仍会进行本地递增绑定尝试,优先保证可用性.

用户建议:
- 不要在 MCP 客户端写死工作区 MCP 动态端口.
- 始终连接 Manager `/mcp`,并按工作区执行握手.

### 日常使用
- `Configure Exposure Tools`: 选择可进入候选集的工具.
- `Configure Enabled Tools`: 在已暴露集合内选择真正启用的工具.
- built-in disabled 工具始终禁用,不可调用.
- 部分默认工具属于策略要求,始终暴露.

### 常见问题
- `workspace not set`:
  - 先执行 `lmToolsBridge.requestWorkspaceMCPServer` 并传 `cwd`.
- `workspace not matched`:
  - 检查 `cwd` 是否位于目标工作区目录内.
- `resolved MCP server is offline`:
  - 确认目标 VS Code 实例和扩展服务在运行.
  - 重新执行握手.
- 端口变化后客户端连接失败:
  - 改为连接 Manager `/mcp`,不要继续连接旧的工作区运行时端口.
- `Tool not found or disabled`:
  - 确认工具同时处于 exposed 和 enabled.

### 工具输出映射
- LM 工具的 `LanguageModelTextPart` 作为 `content.text`.
- `content.text` 只透传 `LanguageModelTextPart`,不会回退读取 `LanguageModelDataPart`.
- LM 工具的 `LanguageModelDataPart` 在 JSON mime type(`application/json`,`application/json; charset=utf-8` 或 `*+json`) 且可解析为 JSON object 时映射为 `structuredContent`.
- 当没有可用 JSON object 作为 `structuredContent` 时,bridge 回退为 `{ blocks: [...] }`.

### Clangd 工具(可选)
通过以下配置启用 clangd MCP 工具:
- `lmToolsBridge.clangd.enabled`

说明:
- AI-first 工具输入已从 `uri` 改为 `filePath`。
- `filePath` 支持:
- 工作区前缀路径,例如 `UE5/Engine/Source/...`
- 绝对路径,例如 `G:/UE_Folder/...` 或 `G:\\UE_Folder\\...`
- `file:///...` URI 输入会被拒绝。
- AI-first 输出统一为摘要文本块:
- 第一行 `counts ...`
- 第二行 `---`
- 后续按 `<path>#<lineOrRange>` + 摘要行输出,条目间用 `---` 分隔
- clangd AI-first 工具同时返回等价语义的 `structuredContent`,便于模型稳定解析:
- 路径字段统一为 `absolutePath`(必有) + `workspacePath`(可空)
- 行列字段使用 1-based 数值,不在结构化字段中拼接 `#line` 文本
- structured 输出避免回显原始输入参数
- `lm_clangd_symbolSearch` 默认在文本摘要和 `structuredContent` 中附带完整符号签名.
- `lm_clangd_symbolInfo` 的 snippet 默认排除 generated 文件(`*.generated.h`, `*.gen.cpp`)来源.
- `lm_clangd_symbolInfo` 现已按符号类别自适应输出,并在变量/字段等 value-like 符号上按需提供 `typeDefinition`.
- `lm_clangd_typeHierarchy` 的 `SOURCE` 区块按 `type -> preview -> path` 顺序输出,更利于 AI 阅读.
- `lm_clangd_typeHierarchy` 的 `structuredContent.sourceByClass` 使用 `absolutePath/workspacePath/startLine/endLine/preview`.
- 工作区内路径格式为 `WorkspaceName/...#line`,工作区外回退为绝对路径。
- 默认暴露的 clangd AI 工具:
- `lm_clangd_status`
- `lm_clangd_switchSourceHeader`
- `lm_clangd_typeHierarchy`
- `lm_clangd_symbolSearch`
- `lm_clangd_symbolBundle`
- `lm_clangd_symbolInfo`
- `lm_clangd_symbolReferences`
- `lm_clangd_symbolImplementations`
- `lm_clangd_callHierarchy`
- `lm_clangd_lspRequest` 受 `lmToolsBridge.clangd.enablePassthrough` 和 `lmToolsBridge.clangd.allowedMethods` 控制.
- 当 `lmToolsBridge.clangd.autoStartOnInvoke=true` 时,首次 clangd 工具调用可自动拉起 clangd.
- `clangd.enable` 是 clangd 扩展配置,不是 `lmToolsBridge.*` 配置项.

### 关键配置
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
- `lmToolsBridge.tools.responseFormat`
- `lmToolsBridge.debug`

建议:
- 如需调整连接端口,优先调整并连接 `lmToolsBridge.manager.httpPort`.

### 命令
- `lm-tools-bridge.start`
- `lm-tools-bridge.stop`
- `lm-tools-bridge.configureExposure`
- `lm-tools-bridge.configureEnabled`
- `lm-tools-bridge.statusMenu`
- `lm-tools-bridge.openHelp`

### 日志
打开 Output 面板并选择 `LM Tools Bridge`.

- `off`: 仅状态日志
- `simple`: 工具名,输入,耗时
- `detail`: 包含完整输出

### 完整变更历史
见 `CHANGELOG.md`.
