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
- Manager log endpoint: `http://127.0.0.1:47100/mcp/log`
- Workspace MCP endpoint (dynamic target): `http://127.0.0.1:<runtime-port>/mcp`
- Status format negotiation:
- Browser requests (`Accept: text/html`) return a human-readable status page with `Refresh` and `Auto refresh (2s)` controls; auto refresh is enabled by default.
- The status page uses responsive layout (`<960px` card-style rows); long values are shown as full multi-line text by default.
- Programmatic requests default to JSON; use `?format=json` to force JSON and `?format=html` to force HTML.

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
7. If client declares `capabilities.roots`, manager requests `roots/list` from client after `notifications/initialized` and `notifications/roots/list_changed`.
8. Roots sync events are logged to `/mcp/log` and summarized in `/mcp/status` (`rootsPolicy`, session roots fields, auto-derived `sessionDetails[].clientCapabilityFlags`/`sessionDetails[].clientCapabilityObjectKeys`, and full `sessionDetails[].clientCapabilities` snapshot from `initialize`).
9. If a stale session header is used on non-`initialize` requests, call `lmToolsBridge.requestWorkspaceMCPServer` again with the current `Mcp-Session-Id` header to re-bind.
10. Handshake result payload includes `mcpSessionId` for diagnostics/observability.

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
- `Status Menu -> Open Extension Page`: open this extension page in VS Code Extensions.
- Built-in disabled tools are always blocked and never callable.
- `copilot_findFiles` and `copilot_findTextInFiles` are built-in disabled and cannot be exposed or enabled.
- Some default tools are policy-required exposure items.

### Diagnostics Tool
- `lm_getDiagnostics` reads diagnostics from VS Code Problems data source (`vscode.languages.getDiagnostics`).
- Inputs: optional `filePaths` (`string[]`), optional `severities` (`error|warning|information|hint`), optional `maxResults` (default `100`).
- `filePaths` supports `WorkspaceName/...` and absolute paths. Empty `filePaths` means no file filter.
- Duplicate `filePaths` entries are deduplicated after trim.
- Legacy `filePath` is ignored when provided.
- `severities` values are matched case-insensitively and deduplicated after normalization. Invalid values return an input error. Default is `error` and `warning` when omitted.
- `maxResults` is strict: it must be an integer >= `1`; invalid values return an input error.
- Unknown input fields are ignored.
- Structured diagnostics no longer include `uri`; each diagnostic includes `preview`, `previewUnavailable`, and `previewTruncated`.
- `preview` returns source code lines from `startLine` to `endLine`, capped at 10 lines.
- `copilot_getErrors` is still available for compatibility, but `lm_getDiagnostics` provides stable structured output.

### Tasks And Debug Tools
- `lm_tasks_runBuild`: starts a build task via `vscode.tasks` without interactive pickers.
- `lm_tasks_runTest`: starts a test task via `vscode.tasks` without interactive pickers.
- `lm_tasks_runBuild` and `lm_tasks_runTest`: when `workspaceFolder` is set in multi-root workspaces, tool selection prefers tasks scoped to that folder and then falls back to workspace-scoped tasks.
- `lm_debug_listLaunchConfigs`: lists launch configurations from both workspace-folder launch settings and workspace-level launch settings.
- `lm_debug_start`: starts debugging via `vscode.debug` with selection priority `index > name > first`; if `name` matches multiple configs, the tool throws an ambiguity error and asks for `index` or `workspaceFolder`.
- All four tools support optional `workspaceFolder` (workspace name or absolute folder path).
- Default policy: these tools are exposed by default, but not enabled by default.

### Troubleshooting
- `workspace not set`:
  - Run `lmToolsBridge.requestWorkspaceMCPServer` with `cwd` first.
- stale or missing `Mcp-Session-Id`:
  - Use `lmToolsBridge.requestWorkspaceMCPServer` to re-bind with the current `Mcp-Session-Id`.
  - Unknown session on non-`initialize` requests returns `Unknown Mcp-Session-Id` and requires handshake.
- `/mcp/log` request noise control:
  - Request-level logs now keep only MCP business ingress (`POST /mcp`, `DELETE /mcp`).
  - Observability endpoints and probes (`GET /mcp/status`, `GET /mcp/log`, `/.well-known/*`, and other non-`/mcp` HTTP requests) are not logged as `[request]` lines.
  - `[rpc]` lines and business logs (`resources.list.*`, `tools.call.*`, `handshake.*`, `roots.list.*`) remain unchanged.
- `roots/list` behavior:
  - `roots/list` is a server-initiated request (`server -> client`) from manager. Do not call it as a normal client request.
  - Declare `capabilities.roots` in `initialize` and handle manager-initiated requests/responses to enable roots sync.
  - Check `/mcp/log` for `roots.*` lines and `/mcp/status` for `rootsPolicy`, per-session roots sync fields, auto-derived capability fields (`sessionDetails[].clientCapabilityFlags`, `sessionDetails[].clientCapabilityObjectKeys`), and `sessionDetails[].clientCapabilities`.
- `workspace not matched`:
  - Check `cwd` points inside the target workspace folder.
- `resolved MCP server is offline`:
  - Ensure target VS Code instance and extension server are running.
  - Re-run handshake.
- Status bar tooltip:
  - Hover `LM Tools Bridge` to view a compact manager ownership summary (manager online/offline, current instance match, and a capped list of other instances/workspaces).
  - Tooltip output is line/length capped for readability and is not a full raw dump of `/mcp/status`.
- `Restart Manager` fails:
  - The restart flow is single-instance priority: stale locks are cleaned automatically, but valid locks owned by another VS Code instance are not forcefully preempted.
  - If lock ownership points to another running instance, restart manager from that instance or close it, then retry.
  - Old-manager shutdown wait timeout in restart flow is 5 seconds.
  - Restart progress is shown on the extension status bar item with a spinner (`$(sync~spin)`), not a notification overlay.
  - Restart result is kept briefly on success (about 1 second) and longer on failure (about 8 seconds) while notifications are still shown.
- manager version upgrade:
  - When `extensionVersion > managerVersion`, the extension auto-triggers manager upgrade restart without an extra click.
  - Upgrade restart uses the same core flow as status-menu `Restart Manager`.
  - If upgrade restart times out, a notification asks you to run `Restart Manager` manually from the status menu.
  - Repeated auto-upgrade failure notifications are throttled to reduce popup noise.
- manager idle auto-shutdown:
  - Manager now waits about 10 seconds of idle grace before self-shutdown after all active instances are gone.
  - Instance liveness TTL is 2.5 seconds to tolerate short heartbeat jitter.
- Client stops working after port change:
  - Connect to Manager `/mcp` instead of old workspace runtime port.
- `Tool not found or disabled`:
  - Ensure the tool is both exposed and enabled.

### Tool Output Mapping
- Built-in custom tools (`lm_find*`, `lm_getDiagnostics`) always return both `content.text` and `structuredContent`.
- For forwarded LM tools (`lm.invokeTool`), output is passthrough-based:
- `content.text` is emitted only when upstream returns `LanguageModelTextPart`.
- `structuredContent` is emitted only when upstream returns a valid JSON object (`LanguageModelDataPart` with JSON mime, or tool-level `structuredContent` object).
- Missing channels are kept missing. The bridge does not copy data across channels.

### Clangd Tools
Clangd MCP tools are deprecated and hard-disabled in this extension build.
- No `lmToolsBridge.clangd.*` enablement settings are exposed.
- `lm_clangd_*` tools are not registered and cannot be enabled from tool settings.
- Historical clangd tool behavior is intentionally omitted because clangd MCP tools are unavailable in this build.

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
- `lmToolsBridge.tools.schemaDefaults` entries use `tool.param=value`; examples are entry values, not JSON string literals.
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
- Manager 日志端点: `http://127.0.0.1:47100/mcp/log`
- Workspace MCP 端点(动态目标): `http://127.0.0.1:<runtime-port>/mcp`
- 状态格式协商:
- 浏览器请求(`Accept: text/html`)会返回人类可读状态页,并提供 `Refresh` 与 `Auto refresh (2s)` 控件; 自动刷新默认开启.
- 状态页采用响应式布局(`<960px` 时按卡片行展示),长文本默认完整多行展示.
- 程序化请求默认返回 JSON; 可使用 `?format=json` 强制 JSON,`?format=html` 强制 HTML.

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
7. 如果客户端在 `initialize` 声明了 `capabilities.roots`,Manager 会在 `notifications/initialized` 和 `notifications/roots/list_changed` 后向客户端发起 `roots/list` 请求.
8. roots 同步事件会写入 `/mcp/log`,并在 `/mcp/status` 中通过 `rootsPolicy`、session roots 字段、自动推导的 capability 字段(`sessionDetails[].clientCapabilityFlags`,`sessionDetails[].clientCapabilityObjectKeys`)以及 `sessionDetails[].clientCapabilities`(来自 `initialize`) 展示摘要.
9. 当 non-`initialize` 请求携带 stale session header 时,需要重新调用 `lmToolsBridge.requestWorkspaceMCPServer` 完成 re-bind.
10. 握手结果 payload 会返回 `mcpSessionId` 便于诊断和观测.

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
- `Status Menu -> Open Extension Page`: 在 VS Code Extensions 中打开本扩展页面.
- Built-in disabled 工具始终被拦截,不可调用.
- `copilot_findFiles` 与 `copilot_findTextInFiles` 属于 built-in disabled,不可 exposed 或 enabled.
- 部分默认工具属于策略要求,必须保持暴露.

### 诊断工具
- `lm_getDiagnostics` 从 VS Code Problems 数据源(`vscode.languages.getDiagnostics`)读取诊断.
- 输入: 可选 `filePaths`(`string[]`),可选 `severities`(`error|warning|information|hint`),可选 `maxResults`(默认 `100`).
- `filePaths` 支持 `WorkspaceName/...` 和绝对路径. 空数组 `filePaths` 等价于不设置文件过滤.
- `filePaths` 在 trim 后会去重重复项.
- 旧字段 `filePath` 传入时会被忽略.
- `severities` 大小写不敏感,归一化后会自动去重; 非法值会返回输入错误. 未传时默认 `error` 和 `warning`.
- `maxResults` 使用严格校验: 必须为 >= `1` 的整数; 非法值会返回输入错误.
- 未定义输入字段会被忽略.
- structured diagnostics 不再包含 `uri`; 每条诊断包含 `preview`,`previewUnavailable`,`previewTruncated`.
- `preview` 返回 `startLine` 到 `endLine` 的源码预览,最多 10 行.
- `copilot_getErrors` 仍保留兼容,但 `lm_getDiagnostics` 提供更稳定的 structured 输出.

### Tasks 与 Debug 工具
- `lm_tasks_runBuild`: 通过 `vscode.tasks` 启动 build task,不使用交互式选择器.
- `lm_tasks_runTest`: 通过 `vscode.tasks` 启动 test task,不使用交互式选择器.
- `lm_tasks_runBuild` 与 `lm_tasks_runTest`: 在 multi-root 且设置 `workspaceFolder` 时,优先选择该 folder 作用域 task,其次回退到 workspace 作用域 task.
- `lm_debug_listLaunchConfigs`: 同时读取 workspace-folder launch 配置与 workspace 级 launch 配置并返回可选列表.
- `lm_debug_start`: 通过 `vscode.debug` 启动调试,选择优先级为 `index > name > first`; 若 `name` 命中多个配置会返回歧义错误,并提示使用 `index` 或 `workspaceFolder`.
- 这 4 个工具都支持可选 `workspaceFolder`(workspace 名称或绝对路径).
- 默认策略: 这些工具默认 exposed,但默认不 enabled.

### 故障排查
- `workspace not set`:
  - 先调用 `lmToolsBridge.requestWorkspaceMCPServer` 并传 `cwd`.
- stale or missing `Mcp-Session-Id`:
  - 使用 `lmToolsBridge.requestWorkspaceMCPServer` 按当前 `Mcp-Session-Id` 重新执行握手.
  - non-`initialize` 请求遇到未知会话时会返回 `Unknown Mcp-Session-Id`,并要求先握手.
- `/mcp/log` 请求降噪:
  - request 级日志仅保留 MCP 业务入口(`POST /mcp`,`DELETE /mcp`).
  - 观测与探测类请求(`GET /mcp/status`,`GET /mcp/log`,`/.well-known/*` 及其他非 `/mcp` HTTP 请求)不再输出 `[request]` 日志行.
  - `[rpc]` 与业务日志(`resources.list.*`,`tools.call.*`,`handshake.*`,`roots.list.*`)保持不变.
- `roots/list` 行为:
  - `roots/list` 是 manager 发起的 `server -> client` 请求,不要再作为普通 client 请求主动调用.
  - 在 `initialize` 声明 `capabilities.roots`,并处理 manager 发起的请求/响应,才能启用 roots 同步.
  - 可在 `/mcp/log` 查看 `roots.*` 日志,并在 `/mcp/status` 查看 `rootsPolicy`、每个 session 的 roots 同步字段、自动推导 capability 字段(`sessionDetails[].clientCapabilityFlags`,`sessionDetails[].clientCapabilityObjectKeys`)与 `sessionDetails[].clientCapabilities`.
- `workspace not matched`:
  - 检查 `cwd` 是否位于目标 workspace 目录内.
- `resolved MCP server is offline`:
  - 确认目标 VS Code 实例和扩展服务正在运行.
  - 重新执行握手.
- 状态栏 tooltip:
  - 鼠标悬停 `LM Tools Bridge` 可查看精简的 manager 归属摘要(manager 在线状态,当前实例是否匹配,以及限量展示的其他实例/工作区).
  - tooltip 输出采用行数和长度限额,不会原样透传 `/mcp/status` 全量字段.
- `Restart Manager` 失败:
  - 重启流程采用单实例优先策略: 会自动清理陈旧锁,但不会强制抢占其他 VS Code 实例持有的有效锁.
  - 若锁归属另一个仍在运行的实例,请在该实例执行重启或先关闭该实例后重试.
  - 重启流程中等待旧 manager 退出的超时窗口为 5 秒.
  - 重启进度显示在扩展状态栏项的转圈图标(`$(sync~spin)`),不再使用通知覆盖层.
  - 重启结果在成功时仅短暂停留(约 1 秒),失败时长时间停留(约 8 秒),同时仍保留通知提示.
- manager 版本升级:
  - 当 `extensionVersion > managerVersion` 时,扩展会自动触发 manager 升级重启,无需额外点击确认.
  - 升级重启与状态菜单 `Restart Manager` 使用同一核心流程.
  - 若升级重启超时,通知会明确提示你从状态菜单手动执行 `Restart Manager`.
  - 自动升级失败通知会节流,减少连续弹窗干扰.
- manager 空闲自动退出:
  - 当所有活跃实例都消失后,manager 会先等待约 10 秒空闲窗口再自退出.
  - 实例存活 TTL 调整为 2.5 秒,用于容忍短暂 heartbeat 抖动.
- 端口变化后客户端不可用:
  - 改连 Manager `/mcp`,不要继续使用旧 workspace runtime 端口.
- `Tool not found or disabled`:
  - 确认该工具同时处于 exposed 和 enabled.

### 工具输出映射
- 内置自定义工具(`lm_find*`,`lm_getDiagnostics`)固定同时返回 `content.text` 和 `structuredContent`.
- 对上游转发 LM tools(`lm.invokeTool`),输出按存在性透传:
- 仅当上游返回 `LanguageModelTextPart` 时输出 `content.text`.
- 仅当上游返回合法 JSON object(来自 JSON mime 的 `LanguageModelDataPart` 或 tool-level `structuredContent` object)时输出 `structuredContent`.
- 缺失通道保持缺失,bridge 不会跨通道复制数据.

### Clangd 工具
当前版本中 clangd MCP tools 已弃用并被硬禁用.
- 不再暴露 `lmToolsBridge.clangd.*` 启用类设置项.
- `lm_clangd_*` 工具不会注册,也无法通过工具设置开启.
- 由于 clangd MCP tools 在当前构建不可用,README 不再描述历史 clangd 工具行为细节.

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
- `lmToolsBridge.tools.schemaDefaults` 采用 `tool.param=value` 条目格式; 示例展示的是 entry 值,不是 JSON 字符串字面量.
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

