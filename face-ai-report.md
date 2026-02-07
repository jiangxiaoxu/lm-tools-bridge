# 面相AI报告: lm-tools-bridge

## 目的
让 AI 在不扫描全仓的情况下快速理解系统做什么, 关键流程如何实现, 以及如何定位代码.

## 适用范围
- 面向 AI agent.
- 聚焦实现路径, 配置影响, 常见失败路径, 关键检索入口.

## 项目定位
lm-tools-bridge 是 VS Code Extension. 目标是将 vscode.lm tools 暴露为本地 MCP HTTP 服务, 并通过 Manager 进程完成 workspace 绑定与端口协调.

## 核心流程图
Flow: 扩展启动与服务启动
Entry: VS Code activation
Path: activate -> getServerConfig -> startMcpServer -> createMcpServer -> registerExposedTools
Output: MCP server listening, status bar Running, Manager heartbeat running

Flow: MCP tool 调用
Entry: HTTP POST /mcp
Path: handleMcpHttpRequest -> invokeExposedTool -> lm.invokeTool -> buildToolResult
Output: content.text 或 structuredContent

Flow: Manager handshake 与转发
Entry: lmToolsBridge.requestWorkspaceMCPServer
Path: handleSessionMessage -> refreshSessionTarget -> checkTargetHealth -> forwardMcpMessage
Output: 绑定成功返回 target, 失败返回错误码

Flow: 自定义搜索工具
Entry: lm_findFiles / lm_findTextInFiles
Path: executeFindFilesSearch / executeFindTextInFilesSearch -> ripgrep
Output: 文件路径或匹配列表

Flow: clangd MCP 工具调用
Entry: lm_clangd_* tools
Path: getClangdToolsSnapshot -> sendRequestWithAutoStart -> ensureClangdRunning -> clangd.activate(按需) -> languageClient.sendRequest
Output: clangd LSP 响应或明确错误

Flow: Tool 暴露计算
Entry: tools/list or tools/call
Path: getEnabledToolsSetting -> getExposedToolsSnapshot -> registerExposedTools
Output: 实际暴露工具列表

Flow: UI 配置启用列表
Entry: command lm-tools-bridge.configureTools
Path: configureExposedTools -> setEnabledTools -> config.update(enabledDelta, disabledDelta)
Output: settings 写入 delta, 工具暴露更新

Flow: 黑名单配置
Entry: command lm-tools-bridge.configureBlacklist
Path: configureBlacklistedTools -> setBlacklistedTools -> config.update(blacklist) -> setEnabledTools
Output: settings 写入 blacklist, 已黑名单工具不可暴露

Flow: 停止服务
Entry: command lm-tools-bridge.stop
Path: stopMcpServer -> server.close -> stopManagerHeartbeat -> refreshStatusBar
Output: MCP server stopped, status bar Off

## 任务驱动索引
Task: 工具未暴露
Entry: tools/list or tools/call
Path: getEnabledToolsSetting -> getExposedToolsSnapshot
Files: src/tooling.ts
Log: "Tool not found or disabled"

Task: 修改默认启用列表
Entry: DEFAULT_ENABLED_TOOL_NAMES
Path: getEnabledToolsSetting
Files: src/tooling.ts

Task: 修改内置黑名单
Entry: BUILTIN_BLACKLISTED_TOOL_NAMES
Path: isToolBlacklisted
Files: src/tooling.ts

Task: schema defaults 不生效
Entry: tools.schemaDefaults
Path: parseSchemaDefaultOverrideEntry -> getSchemaDefaultOverrides
Files: src/tooling.ts
Log: "lmToolsBridge.tools.schemaDefaults ignored"

Task: Manager 绑定失败
Entry: lmToolsBridge.requestWorkspaceMCPServer
Path: refreshSessionTarget -> checkTargetHealth
Files: src/manager.ts
Log: "No matching VS Code instance", "Resolved MCP server is offline"

Task: 搜索结果不完整
Entry: lm_findFiles / lm_findTextInFiles
Path: executeFindFilesSearch / executeFindTextInFilesSearch
Files: src/searchTools.ts
Log: "Results capped"

Task: 变更输出格式
Entry: tools.responseFormat
Path: buildToolResult
Files: src/tooling.ts

Task: clangd 工具未暴露
Entry: lmToolsBridge.clangd.enabled
Path: isClangdMcpEnabled -> getClangdToolsSnapshot -> getCustomToolsSnapshot
Files: src/clangd/index.ts, src/tooling.ts
Log: "Tool not found or disabled"

Task: clangd 调用失败或未启动
Entry: lm_clangd_* call
Path: sendRequestWithAutoStart -> ensureClangdRunning -> startClangdAndWait
Files: src/clangd/transport.ts, src/clangd/bootstrap.ts
Log: "Unable to obtain clangd client", "clangd request retry failed"

## 关键配置与行为矩阵
Key: lmToolsBridge.server.autoStart
Effect: Auto start MCP server
Code: getServerConfig -> startMcpServer

Key: lmToolsBridge.server.port
Effect: Preferred port selection
Code: startMcpServer

Key: lmToolsBridge.manager.httpPort
Effect: Manager gateway port
Code: managerClient.ts

Key: lmToolsBridge.useWorkspaceSettings
Effect: Settings scope selection
Code: configuration.ts

Key: lmToolsBridge.tools.enabledDelta
Effect: Add enablement over defaults
Code: getEnabledToolsSetting

Key: lmToolsBridge.tools.disabledDelta
Effect: Remove enablement over defaults
Code: getEnabledToolsSetting

Key: lmToolsBridge.tools.blacklist
Effect: Force hide tools
Code: getVisibleToolsSnapshot, getExposedToolsSnapshot

Key: lmToolsBridge.tools.blacklistPatterns
Effect: Wildcard hide tools
Code: compileBlacklistPatterns

Key: lmToolsBridge.tools.schemaDefaults
Effect: Inject schema and input defaults
Code: getSchemaDefaultOverrides, applySchemaDefaults

Key: lmToolsBridge.tools.responseFormat
Effect: Output format control
Code: buildToolResult

Key: lmToolsBridge.debug
Effect: Log verbosity
Code: getDebugLevel

Key: lmToolsBridge.clangd.enabled
Effect: Gate all lm_clangd_* tools
Code: getClangdToolsSnapshot

Key: lmToolsBridge.clangd.autoStartOnInvoke
Effect: Auto trigger clangd.activate when client missing
Code: ensureClangdRunning, startClangdAndWait

Key: lmToolsBridge.clangd.enablePassthrough
Effect: Enable/disable lm_clangd_lspRequest exposure
Code: getClangdToolsSnapshot

Key: lmToolsBridge.clangd.requestTimeoutMs
Effect: Timeout for clangd MCP requests
Code: sendRequestWithAutoStart, sendWithTimeout

Key: lmToolsBridge.clangd.allowedMethods
Effect: Allowlist for lm_clangd_lspRequest
Code: getEffectiveAllowedPassthroughMethods

## 行为不变量
Invariant: tools.disabledDelta 优先级高于 tools.enabledDelta.
Invariant: blacklist 与 blacklistPatterns 永远生效.
Invariant: tool input 必须是 object, 否则返回 error payload.
Invariant: tools.schemaDefaults 只接受 schema 内已定义字段.
Invariant: responseFormat 控制 content 与 structuredContent 的存在.
Invariant: 未启用或被禁用的工具返回 MethodNotFound.
Invariant: `lmToolsBridge.clangd.enabled=false` 时不暴露任何 lm_clangd_* 工具.
Invariant: clangd 自动启动最多触发一次 in-flight, 并发请求共享同一启动流程.
Invariant: `lm_clangd_lspRequest` 只允许 allowlist method.
Invariant: workspace untrusted 时 clangd MCP 请求必须拒绝.
Invariant: 低价值工具 `lm_clangd_memoryUsage` 和 `lm_clangd_inlayHints` 默认不暴露.
Invariant: passthrough 默认 allowlist 不包含 completion, semanticTokens, memoryUsage, inlayHints.
Invariant: clangd MCP 输入输出中的 line/character 统一按 1-based 表达, 并在 LSP 边界自动转换.

## 失败路径矩阵
Case: 端口占用且重试失败
Result: status bar Port In Use
Code: startMcpServer

Case: 工具未启用
Result: MethodNotFound + "Tool not found or disabled"
Code: invokeExposedTool

Case: tool input 非 object
Result: error payload + inputSchema
Code: invokeExposedTool

Case: workspace 无匹配
Result: ERROR_NO_MATCH
Code: refreshSessionTarget

Case: 目标离线
Result: ERROR_MCP_OFFLINE
Code: checkTargetHealth

Case: Manager 不可达
Result: ERROR_MANAGER_UNREACHABLE
Code: forwardMcpMessage

Case: clangd extension 未安装
Result: CLANGD_EXTENSION_MISSING
Code: startClangdAndWait

Case: clangd 请求超时
Result: REQUEST_TIMEOUT
Code: sendWithTimeout

Case: passthrough method 不在 allowlist
Result: METHOD_NOT_ALLOWED
Code: runLspRequestTool

## 最小调用示例
Example: Handshake
1. Call lmToolsBridge.requestWorkspaceMCPServer with params.cwd
2. Read lm-tools://names
3. Read lm-tools://schema/{name}

Example: Tool call
1. POST /mcp with tools/call name + input object
2. Expect content.text and/or structuredContent based on tools.responseFormat

Example: Direct tool call
1. Call lmToolsBridge.callTool after handshake
2. Pass { name, arguments }

## 关键索引种子
Seed: DEFAULT_ENABLED_TOOL_NAMES | Use: 定位默认启用列表
Seed: BUILTIN_BLACKLISTED_TOOL_NAMES | Use: 定位内置黑名单
Seed: BUILTIN_SCHEMA_DEFAULT_OVERRIDES | Use: 定位内置 schema defaults
Seed: getEnabledToolsSetting | Use: 启用列表计算入口
Seed: getExposedToolsSnapshot | Use: 实际暴露列表入口
Seed: configureExposedTools | Use: UI 配置启用入口
Seed: configureBlacklistedTools | Use: UI 配置黑名单入口
Seed: invokeExposedTool | Use: MCP tool 调用入口
Seed: buildToolResult | Use: 输出格式组装
Seed: applySchemaDefaults | Use: schema defaults 注入
Seed: applyInputDefaultsToToolInput | Use: 输入 defaults 注入
Seed: lmToolsBridge.requestWorkspaceMCPServer | Use: Manager handshake
Seed: lmToolsBridge.callTool | Use: Manager 直通 tool
Seed: /mcp/status | Use: Manager 运行状态
Seed: notifications/tools/list_changed | Use: tool list 变更通知
Seed: getClangdToolsSnapshot | Use: clangd 工具暴露入口
Seed: ensureClangdRunning | Use: clangd 按需启动入口
Seed: sendRequestWithAutoStart | Use: clangd 请求统一入口
Seed: lm_clangd_status | Use: clangd 可用性诊断
Seed: lm_clangd_lspRequest | Use: clangd 受限透传调用

## 默认与内置列表的映射
Default enabled source: DEFAULT_ENABLED_TOOL_NAMES in src/tooling.ts
Default blacklist source: BUILTIN_BLACKLISTED_TOOL_NAMES in src/tooling.ts
Schema defaults source: BUILTIN_SCHEMA_DEFAULT_OVERRIDES in src/tooling.ts

## 模块依赖与数据流
Graph:
- extension.ts -> tooling.ts -> searchTools.ts
- tooling.ts -> clangd/index.ts -> clangd/tools/*
- extension.ts -> managerClient.ts -> manager.ts
- tooling.ts -> configuration.ts

DataFlow:
- VS Code activation -> MCP server -> tools/resources
- Manager handshake -> target resolve -> MCP forward
- Settings -> enablement/blacklist/schema defaults -> exposed tools
- clangd tool call -> bootstrap -> clangd language client -> LSP response

## 更新策略
当以下任一项变化时更新本报告:
- 增减核心流程或入口函数
- 变更配置项语义或优先级
- 调整 Manager 或 MCP 调用路径
- 修改默认启用或黑名单策略
