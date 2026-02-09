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
Output: content.text(仅来自 LanguageModelTextPart) 或 structuredContent(优先来自 LanguageModelDataPart JSON object,支持 application/json; charset=... 与 *+json)

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
Output: AI-first 摘要文本输出(counts + section + entries)或明确错误

Flow: Tool 暴露计算
Entry: tools/list or tools/call
Path: getExposedToolsSetting -> getEnabledToolsSetting -> getEnabledExposedToolsSnapshot -> registerExposedTools
Output: 实际暴露工具列表

Flow: UI 配置暴露列表
Entry: command lm-tools-bridge.configureExposure
Path: configureExposureTools -> getToolGroupingRulesFromConfig -> buildGroupedToolSections -> showToolConfigPanel -> setExposedTools -> normalizeToolSelectionState
Output: settings 写入 exposed/unexposed delta, 并自动清理内置禁用项和无效 enabled delta

Flow: UI 配置启用列表
Entry: command lm-tools-bridge.configureEnabled
Path: configureEnabledTools -> getToolGroupingRulesFromConfig -> buildGroupedToolSections -> showToolConfigPanel -> setEnabledTools
Output: settings 写入 enabled/disabled delta, 仅对已暴露工具生效

Flow: 停止服务
Entry: command lm-tools-bridge.stop
Path: stopMcpServer -> server.close -> stopManagerHeartbeat -> refreshStatusBar
Output: MCP server stopped, status bar Off

## 任务驱动索引
Task: 工具未暴露
Entry: tools/list or tools/call
Path: getExposedToolsSetting -> getEnabledToolsSetting -> getEnabledExposedToolsSnapshot
Files: src/tooling.ts
Log: "Tool not found or disabled"

Task: 修改默认启用列表
Entry: DEFAULT_ENABLED_TOOL_NAMES
Path: getEnabledToolsSetting
Files: src/tooling.ts

Task: 修改默认暴露列表
Entry: DEFAULT_EXPOSED_TOOL_NAMES
Path: getExposedToolsSetting
Files: src/tooling.ts

Task: 配置页分组或折叠异常
Entry: showToolConfigPanel
Path: configureExposureTools/configureEnabledTools -> showToolConfigPanel -> (fallback) pickToolsWithQuickPick
Files: src/toolConfigPanel.ts, src/toolGrouping.ts, src/tooling.ts
Log: "Tool config panel failed, fallback to QuickPick"

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

Task: clangd filePath 输入解析失败
Entry: lm_clangd_* call with filePath
Path: resolveInputFilePath
Files: src/clangd/workspacePath.ts
Log: "Input no longer accepts URI. Use 'filePath' instead of 'uri'."

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

Key: lmToolsBridge.tools.exposedDelta
Effect: Add exposure over defaults
Code: getExposedToolsSetting

Key: lmToolsBridge.tools.unexposedDelta
Effect: Remove exposure over defaults
Code: getExposedToolsSetting

Key: lmToolsBridge.tools.groupingRules
Effect: Regex-based custom UI grouping rules for tools
Code: getToolGroupingRulesFromConfig, buildGroupedToolSections

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
Invariant: tools.unexposedDelta 优先级高于 tools.exposedDelta.
Invariant: BUILTIN_DISABLED_TOOL_NAMES 优先级高于 REQUIRED_EXPOSED_TOOL_NAMES.
Invariant: tools.groupingRules 优先级高于内置来源分组, 并按配置顺序首命中生效.
Invariant: effective tools = exposed intersection enabled.
Invariant: unexposed 工具必须被自动从 enabledDelta/disabledDelta 清理.
Invariant: 内置禁用工具必须被自动从 exposedDelta/unexposedDelta/enabledDelta/disabledDelta 清理.
Invariant: DEFAULT_ENABLED_TOOL_NAMES 中的工具必须始终暴露, 不可在 Exposure UI 中取消.
Invariant: 内置禁用工具在 Exposure 中只能出现在 `Built-in Disabled` 父组下的来源子组, 且只读.
Invariant: 内置禁用工具不能进入 effectiveExposed/effectiveEnabled, 且不显示在 Enabled UI.
Invariant: Exposure UI 中只读项需有明显视觉区分: `Always Exposed` 与 `Built-in Disabled` 使用不同 badge/色彩.
Invariant: Exposure UI 中“全只读分组”不显示组级复选框, 避免误导可批量编辑.
Invariant: tool input 必须是 object, 否则返回 error payload.
Invariant: tools.schemaDefaults 只接受 schema 内已定义字段.
Invariant: responseFormat 控制 content 与 structuredContent 的存在.
Invariant: 转发 LM tool 结果时,content.text 仅来自 LanguageModelTextPart; LanguageModelDataPart(JSON mime,含 application/json; charset=... 与 *+json) 的 JSON object 优先作为 structuredContent; 无可用 JSON object 时 structuredContent 回退为 blocks 包装.
Invariant: 未启用或被禁用的工具返回 MethodNotFound.
Invariant: `lmToolsBridge.clangd.enabled=false` 时不暴露任何 lm_clangd_* 工具.
Invariant: clangd 自动启动最多触发一次 in-flight, 并发请求共享同一启动流程.
Invariant: `lm_clangd_lspRequest` 只允许 allowlist method.
Invariant: workspace untrusted 时 clangd MCP 请求必须拒绝.
Invariant: 低价值工具 `lm_clangd_memoryUsage` 和 `lm_clangd_inlayHints` 默认不暴露.
Invariant: `lm_clangd_ast` 不再暴露,并从默认 exposed/enabled 清单移除.
Invariant: passthrough 默认 allowlist 不包含 completion, semanticTokens, memoryUsage, inlayHints.
Invariant: clangd AI-first 工具输入统一使用 `filePath`, 支持 `WorkspaceName/...` 与绝对路径, 拒绝 `file:///...`.
Invariant: clangd AI-first 工具输出统一为 summary text 协议(counts 行 + `---` 分隔 + `<path>#<lineOrRange>` + summary).
Invariant: clangd AI-first 工具同时提供等价语义的 `structuredContent`.
Invariant: structured location 字段统一为 `absolutePath`(必有) + `workspacePath`(可空) + 1-based 坐标,不再使用 `summaryPath/path#...`.
Invariant: `lm_clangd_symbolInfo` 的 `structuredContent.entries[]` 仅使用 `location.preview` 提供行预览,不再输出重复的顶层 `line` 字段.
Invariant: `lm_clangd_symbolSearch` 默认返回完整签名,并按 `signatureHelp -> hover -> definitionLine` 回退补全.
Invariant: clangd tool input 的 line/character 对外统一按 1-based 表达, 并在 LSP 边界自动转换.
Invariant: `lm_clangd_typeHierarchyResolve` 不再作为独立工具暴露.

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
Seed: DEFAULT_EXPOSED_TOOL_NAMES | Use: 定位默认暴露列表
Seed: BUILTIN_DISABLED_TOOL_NAMES | Use: 定位内置禁用列表
Seed: BUILTIN_SCHEMA_DEFAULT_OVERRIDES | Use: 定位内置 schema defaults
Seed: getEnabledToolsSetting | Use: 启用列表计算入口
Seed: getExposedToolsSetting | Use: 暴露列表计算入口
Seed: normalizeToolSelectionState | Use: settings 归一化与自动清理入口
Seed: getExposedToolsSnapshot | Use: 当前暴露工具快照
Seed: getEnabledExposedToolsSnapshot | Use: 最终可调用工具快照
Seed: configureExposureTools | Use: UI 配置暴露入口
Seed: configureEnabledTools | Use: UI 配置启用入口
Seed: getToolGroupingRulesFromConfig | Use: 自定义 regex 分组规则解析入口
Seed: showToolConfigPanel | Use: 分组树形配置页入口
Seed: buildGroupedToolSections | Use: 来源分组与组状态计算
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
Seed: resolveInputFilePath | Use: clangd filePath 输入解析入口
Seed: toStructuredLocation | Use: clangd 结构化位置对象规范化入口
Seed: formatSummaryPath | Use: clangd 摘要路径渲染入口
Seed: lm_clangd_status | Use: clangd 可用性诊断
Seed: lm_clangd_typeHierarchy | Use: clangd 继承链摘要
Seed: lm_clangd_symbolSearch | Use: clangd 名字/正则检索
Seed: lm_clangd_symbolBundle | Use: clangd 聚合信息单次查询入口
Seed: lm_clangd_symbolInfo | Use: clangd 符号定义摘要
Seed: lm_clangd_symbolReferences | Use: clangd 引用关系摘要
Seed: lm_clangd_symbolImplementations | Use: clangd 实现点摘要
Seed: lm_clangd_callHierarchy | Use: clangd 调用关系摘要
Seed: lm_clangd_lspRequest | Use: clangd 受限透传调用

## 默认与内置列表的映射
Default enabled source: DEFAULT_ENABLED_TOOL_NAMES in src/tooling.ts
Default exposed source: DEFAULT_EXPOSED_TOOL_NAMES in src/tooling.ts
Schema defaults source: BUILTIN_SCHEMA_DEFAULT_OVERRIDES in src/tooling.ts

## 模块依赖与数据流
Graph:
- extension.ts -> tooling.ts -> searchTools.ts
- tooling.ts -> toolGrouping.ts -> toolConfigPanel.ts
- tooling.ts -> clangd/index.ts -> clangd/tools/*
- extension.ts -> managerClient.ts -> manager.ts
- tooling.ts -> configuration.ts

DataFlow:
- VS Code activation -> MCP server -> tools/resources
- Manager handshake -> target resolve -> MCP forward
- Settings -> exposure delta + enabled delta + schema defaults -> effective tools
- clangd tool call -> bootstrap -> clangd language client -> LSP response

## 更新策略
当以下任一项变化时更新本报告:
- 增减核心流程或入口函数
- 变更配置项语义或优先级
- 调整 Manager 或 MCP 调用路径
- 修改默认启用或默认暴露策略
