# LM Tools Bridge

[English](#overview) | [中文](#中文)

### Overview
LM Tools Bridge is a VS Code extension that exposes LM tools through MCP HTTP.
It uses a built-in Manager to route requests to the correct workspace MCP server.

This README covers the current Manager-based version only.

### Quick Start
1. Start the extension server in VS Code with `LM Tools Bridge: Start Server` (or enable `lmToolsBridge.server.autoStart`).
2. In your MCP client, connect to Manager endpoint `http://127.0.0.1:47100/mcp` (or `http://127.0.0.1:<lmToolsBridge.manager.httpPort>/mcp`).
3. Before tool calls, run handshake `lmToolsBridge.requestWorkspaceMCPServer` with `{ "cwd": "<your project path>" }`.
4. Use `discovery` in handshake response for `callTool` and `bridgedTools`. Use `tools/list` only as refresh fallback.

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
4. Read `callTool`, `bridgedTools`, and `resourceTemplates` from handshake `discovery`.
5. Compose tool/schema URIs with templates and tool `name` (`lm-tools://tool/{name}`, `lm-tools://schema/{name}`).
6. Use `lmToolsBridge.callTool` or standard `tools/call`.
7. If session header is lost/expired, call `lmToolsBridge.requestWorkspaceMCPServer` again; manager can auto-recover a new session for handshake calls and returns a fresh `Mcp-Session-Id` header.

### Handshake Discovery Payload
- A successful handshake includes `discovery` with:
- `callTool`: dedicated manager bridge tool descriptor (`lmToolsBridge.callTool`) with inline `inputSchema`
- `bridgedTools`: workspace MCP tools only (`name`, `description`; `description` includes a simple `Input: { ... }` hint when schema is available)
- `resourceTemplates`: URI templates for composition (`lm-tools://tool/{name}`, `lm-tools://schema/{name}`)
- `partial` and `issues`: `partial` is raised by `error`-level issues (for example `tools/list` failures); `warning` issues report non-blocking degradations such as schema-read failures
- `issues` entry shape: `{ level: "error" | "warning", category, code, message, toolName?, details? }`
- Input hints in discovery are schema-resource based (`lm-tools://schema/{name}`), and schema-read failures are reported in `issues` with `level: "warning"`.

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
- `Status Menu -> Open Settings`: jump directly to this extension's settings page.
- Built-in disabled tools are always blocked and never callable.
- Some default tools are policy-required exposure items.

### Diagnostics Tool
- `lm_getDiagnostics` reads diagnostics from VS Code Problems data source (`vscode.languages.getDiagnostics`).
- Inputs: optional `filePath`, optional `severities` (`error|warning|information|hint`), optional `maxResults` (default `500`).
- Default severities are `error` and `warning`.
- Structured diagnostics no longer include `uri`; each diagnostic includes `preview`, `previewUnavailable`, and `previewTruncated`.
- `preview` returns source code lines from `startLine` to `endLine`, capped at 10 lines.
- `copilot_getErrors` is still available for compatibility, but `lm_getDiagnostics` provides stable structured output.

### Troubleshooting
- `workspace not set`:
  - Run `lmToolsBridge.requestWorkspaceMCPServer` with `cwd` first.
- stale or missing `Mcp-Session-Id`:
  - `lmToolsBridge.requestWorkspaceMCPServer` can auto-recover by issuing a new session header; if the client still caches old headers, re-initialize once.
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
- Built-in custom tools (`lm_find*`, `lm_getDiagnostics`, `lm_clangd_*`) always return both `content.text` and `structuredContent`.
- For forwarded LM tools (`lm.invokeTool`), output is passthrough-based:
- `content.text` is emitted only when upstream returns `LanguageModelTextPart`.
- `structuredContent` is emitted only when upstream returns a valid JSON object (`LanguageModelDataPart` with JSON mime, or tool-level `structuredContent` object).
- Missing channels are kept missing. The bridge does not copy data across channels.

### Clangd Tools (Optional)
Enable clangd MCP tools with:
- `lmToolsBridge.clangd.enabled`
- Clangd tools are exposed by default but not enabled by default.

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
- `lmToolsBridge.useWorkspaceSettings` is workspace-only. If it is written in User settings, the extension removes it automatically and shows a warning.
- `lmToolsBridge.tools.exposedDelta`
- `lmToolsBridge.tools.unexposedDelta`
- `lmToolsBridge.tools.enabledDelta`
- `lmToolsBridge.tools.disabledDelta`
- `lmToolsBridge.tools.groupingRules`
- `lmToolsBridge.tools.schemaDefaults`
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
它内置 Manager,用于把请求路由到正确的 workspace MCP server.

本 README 仅覆盖当前基于 Manager 的版本.

### 快速开始
1. 在 VS Code 里用 `LM Tools Bridge: Start Server` 启动服务(或开启 `lmToolsBridge.server.autoStart`).
2. 在 MCP 客户端连接 Manager 端点 `http://127.0.0.1:47100/mcp`(或 `http://127.0.0.1:<lmToolsBridge.manager.httpPort>/mcp`).
3. 调用工具前先执行握手 `lmToolsBridge.requestWorkspaceMCPServer`,参数为 `{ "cwd": "<你的项目路径>" }`.
4. 使用握手响应里的 `discovery` 获取 `callTool` 和 `bridgedTools`. `tools/list` 仅作为刷新回退使用.

### 端点
- Manager MCP 端点(客户端入口): `http://127.0.0.1:47100/mcp`
- Manager 状态端点(诊断): `http://127.0.0.1:47100/mcp/status`
- Workspace MCP 端点(动态目标): `http://127.0.0.1:<runtime-port>/mcp`

### Manager 与 Workspace MCP Server 的关系
- Manager 是稳定的客户端 MCP 入口.
- Workspace MCP server 由某个 VS Code 实例承载,会随实例或重启发生变化.
- Manager 会基于 `cwd` 完成 workspace 匹配,健康检查和请求转发.
- 为了稳定性,请让 MCP 客户端连接 Manager,不要直接连接 workspace MCP 动态端口.

### 如何连接你的 MCP 客户端
1. 将 MCP URL 配置为 `http://127.0.0.1:47100/mcp`(或自定义 manager 端口).
2. 发送 `initialize`,并保存返回的 `Mcp-Session-Id` 响应头.
3. 调用 `lmToolsBridge.requestWorkspaceMCPServer`,传入 `cwd`.
4. 从握手 `discovery` 中读取 `callTool`,`bridgedTools`,`resourceTemplates`.
5. 使用模板和工具 `name` 组装 tool/schema URI(`lm-tools://tool/{name}`,`lm-tools://schema/{name}`).
6. 使用 `lmToolsBridge.callTool` 或标准 `tools/call`.
7. 如果会话头丢失或过期,再次调用 `lmToolsBridge.requestWorkspaceMCPServer`. Manager 会在握手调用中自动恢复会话并返回新的 `Mcp-Session-Id`.

### 握手 discovery 载荷
- 成功握手会返回包含以下字段的 `discovery`:
- `callTool`: 专用 manager bridge 工具描述(`lmToolsBridge.callTool`),并内联 `inputSchema`
- `bridgedTools`: 仅 workspace MCP tools(`name`,`description`); 当 schema 可用时,`description` 会附带简化 `Input: { ... }` 提示
- `resourceTemplates`: URI 模板(`lm-tools://tool/{name}`,`lm-tools://schema/{name}`)
- `partial` 和 `issues`: `partial` 由 `error` 级 issue 触发(例如 `tools/list` 失败); `warning` 级 issue 用于报告非阻断退化,例如 schema 读取失败
- `issues` 条目结构: `{ level: "error" | "warning", category, code, message, toolName?, details? }`
- discovery 里的输入提示来自 schema resource(`lm-tools://schema/{name}`),schema 读取失败会以 `level: "warning"` 写入 `issues`.

配置示例:

```toml
[mcp_servers.lm_tools_bridge]
url = "http://127.0.0.1:47100/mcp"
```

### 端口避让机制
- Workspace 端口偏好起点来自 `lmToolsBridge.server.port`.
- Manager 通过 `POST /allocate` 先尝试分配一个尽量不冲突的候选端口.
- 分配时会考虑活跃实例端口和短期保留端口,减少 VS Code 多实例冲突.
- 扩展真正绑定 socket 时,如果出现 `EADDRINUSE`,会自动递增重试(最多 50 次).
- 超过重试上限时,状态栏显示 `Port In Use`.
- 即使 Manager 暂时不可用,扩展仍会执行本地递增绑定以优先保证可用性.

用户建议:
- 不要在 MCP 客户端里写死 workspace MCP runtime 端口.
- 始终连接 Manager `/mcp`,并按 workspace 执行握手.

### 日常使用
- `Configure Exposure Tools`: 选择可进入候选集的工具.
- `Configure Enabled Tools`: 在已暴露集合内选择真正启用的工具.
- `Status Menu -> Open Settings`: 直接跳转到扩展设置页.
- Built-in disabled 工具始终被拦截,不可调用.
- 部分默认工具属于策略要求,必须保持暴露.

### 诊断工具
- `lm_getDiagnostics` 从 VS Code Problems 数据源(`vscode.languages.getDiagnostics`)读取诊断.
- 输入: 可选 `filePath`,可选 `severities`(`error|warning|information|hint`),可选 `maxResults`(默认 `500`).
- 默认 severity 为 `error` 和 `warning`.
- structured diagnostics 不再包含 `uri`; 每条诊断包含 `preview`,`previewUnavailable`,`previewTruncated`.
- `preview` 返回 `startLine` 到 `endLine` 的源码预览,最多 10 行.
- `copilot_getErrors` 仍保留兼容,但 `lm_getDiagnostics` 提供更稳定的 structured 输出.

### 故障排查
- `workspace not set`:
  - 先调用 `lmToolsBridge.requestWorkspaceMCPServer` 并传 `cwd`.
- stale or missing `Mcp-Session-Id`:
  - `lmToolsBridge.requestWorkspaceMCPServer` 可自动恢复新 session header; 如客户端仍缓存旧 header,请重新 initialize 一次.
- `workspace not matched`:
  - 检查 `cwd` 是否位于目标 workspace 目录内.
- `resolved MCP server is offline`:
  - 确认目标 VS Code 实例和扩展服务正在运行.
  - 重新执行握手.
- 端口变化后客户端不可用:
  - 改连 Manager `/mcp`,不要继续使用旧 workspace runtime 端口.
- `Tool not found or disabled`:
  - 确认该工具同时处于 exposed 和 enabled.

### 工具输出映射
- 内置自定义工具(`lm_find*`,`lm_getDiagnostics`,`lm_clangd_*`)固定同时返回 `content.text` 和 `structuredContent`.
- 对上游转发 LM tools(`lm.invokeTool`),输出按存在性透传:
- 仅当上游返回 `LanguageModelTextPart` 时输出 `content.text`.
- 仅当上游返回合法 JSON object(来自 JSON mime 的 `LanguageModelDataPart` 或 tool-level `structuredContent` object)时输出 `structuredContent`.
- 缺失通道保持缺失,bridge 不会跨通道复制数据.

### Clangd 工具(可选)
通过以下设置启用 clangd MCP tools:
- `lmToolsBridge.clangd.enabled`
- clangd 工具默认 exposed,但默认不 enabled.

说明:
- AI-first 工具已使用 `filePath` 输入替代 `uri`.
- `filePath` 支持:
- workspace 前缀路径,例如 `UE5/Engine/Source/...`
- 绝对路径,例如 `G:/UE_Folder/...` 或 `G:\\UE_Folder\\...`
- `file:///...` URI 输入会被拒绝.
- AI-first 输出使用摘要文本块:
- 第一行 `counts ...`
- 第二行 `---`
- 后续按 `<path>#<lineOrRange>` + summary 行输出,条目之间以 `---` 分隔
- clangd AI-first 工具也返回 `structuredContent` 机读字段:
- 路径字段为 `absolutePath`(始终存在) + `workspacePath`(可空)
- 行列字段保持 1-based 数值字段,不使用 `path#...` 字符串
- structured 输出避免回显原始输入参数
- `lm_clangd_symbolSearch` 现在默认在 text summary 与 `structuredContent` 中包含完整 symbol signature.
- `lm_clangd_symbolInfo` 默认排除 generated 文件(`*.generated.h`, `*.gen.cpp`)的 snippet 来源.
- `lm_clangd_symbolInfo` 现在使用自适应 symbol-category 输出,并在 value-like symbols 上按需包含 `typeDefinition`.
- `lm_clangd_typeHierarchy` 的 `SOURCE` 区块现在按 `type -> preview -> path` 输出,更利于 AI 阅读.
- `lm_clangd_typeHierarchy` 的 `structuredContent.sourceByClass` 包含 `absolutePath/workspacePath/startLine/endLine/preview`.
- summary path 格式为: workspace 内文件使用 `WorkspaceName/...#line`,workspace 外文件使用绝对路径.
- 默认暴露的 clangd AI tools:
- `lm_clangd_status`
- `lm_clangd_switchSourceHeader`
- `lm_clangd_typeHierarchy`
- `lm_clangd_symbolSearch`
- `lm_clangd_symbolBundle`
- `lm_clangd_symbolInfo`
- `lm_clangd_symbolReferences`
- `lm_clangd_symbolImplementations`
- `lm_clangd_callHierarchy`
- `lm_clangd_lspRequest` 由 `lmToolsBridge.clangd.enablePassthrough` 和 `lmToolsBridge.clangd.allowedMethods` 控制.
- 当 `lmToolsBridge.clangd.autoStartOnInvoke=true` 时,首次 clangd 工具调用可自动拉起 clangd.
- `clangd.enable` 属于 clangd 扩展设置,不是 `lmToolsBridge.*` 设置.

### 关键设置
- `lmToolsBridge.server.autoStart`
- `lmToolsBridge.server.port`
- `lmToolsBridge.manager.httpPort`
- `lmToolsBridge.useWorkspaceSettings` 仅支持 workspace 级. 若写入 User settings,扩展会自动移除并给出 warning.
- `lmToolsBridge.tools.exposedDelta`
- `lmToolsBridge.tools.unexposedDelta`
- `lmToolsBridge.tools.enabledDelta`
- `lmToolsBridge.tools.disabledDelta`
- `lmToolsBridge.tools.groupingRules`
- `lmToolsBridge.tools.schemaDefaults`
- `lmToolsBridge.debug`

建议:
- 如需调整连接端口,优先调整 `lmToolsBridge.manager.httpPort` 供客户端连接.

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
参见 `CHANGELOG.md`.

