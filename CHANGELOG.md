# Changelog

All notable changes to this project are documented in this file.

Maintenance rule:
- For each release, keep both `### English` and `### 中文` sections.
- Keep section order aligned to reduce translation drift.

## [Unreleased]

### English

#### Changed
- Standardized custom search/diagnostics output for `lm_findTextInFiles`, `lm_findFiles`, and `lm_getDiagnostics`: `structuredContent` is now always a JSON object, while `content.text` is a human-readable summary.
- Updated find summaries to remove `showing: x/y` truncation and use block-style entries (`---`, `// path:line`, preview on next line for text matches; full path list for file matches).
- Updated `lm_findFiles` summary path lines to output raw file paths (without `//` prefix) while keeping `---` separators.
- Fixed handshake discovery `tools/list` fetch format by using a valid internal JSON-RPC request id (instead of `id: null`), so `discovery.bridgedTools` can be populated when workspace tools are available.
- Updated `lmToolsBridge.requestWorkspaceMCPServer` tool-call text output to a human-readable multi-line summary while keeping `structuredContent` as the full JSON payload.
- Breaking change: removed per-tool `toolUri`/`schemaUri` from handshake discovery tool entries and added discovery-level `resourceTemplates` (`lm-tools://tool/{name}`, `lm-tools://schema/{name}`) for client-side URI composition.
- Improved handshake discovery input hints: manager now reads `lm-tools://schema/{name}` for bridged tools to derive real `Input: {...}` signatures and no longer emits misleading `Input: {}` fallback.
- Discovery diagnostics are now unified under `discovery.issues` with hierarchical entries (`level`, `category`, `code`, `message`, optional `toolName/details`) for both errors and warnings.
- Schema-read misses during discovery are now reported as `warning` issues (instead of silent degradation) while preserving non-blocking fallback behavior.
- Updated `requestWorkspaceMCPServer` human-readable text summary to include an indented bridged tool name list under `tools:` while keeping `structuredContent` unchanged.
- Marked `copilot_getErrors` and `copilot_readProjectStructure` as built-in disabled (never exposed/enabled).
- Handshake response now uses a compact discovery payload (`callTool`, `bridgedTools`, `resourceTemplates`, `partial`, `issues`) to reduce extra list calls after `lmToolsBridge.requestWorkspaceMCPServer`.
- `discovery.partial` is now driven by `error`-level issues only; `warning` issues do not mark discovery as partial.
- `discovery.callTool` is a dedicated manager bridge descriptor with inline `inputSchema`; `lmToolsBridge.requestWorkspaceMCPServer` is excluded from discovery tool items.
- `discovery.bridgedTools[].description` appends a simple `Input: { ... }` hint when tool schema metadata is available.
- `discovery` no longer returns `resources`; it now returns handshake-level `resourceTemplates` for URI composition.
- Updated defaults for clangd tools: they are exposed by default but not enabled by default.
- Improved manager session resilience for handshake calls: when `Mcp-Session-Id` is missing or stale, `lmToolsBridge.requestWorkspaceMCPServer` now auto-recovers with a new session header instead of failing early with HTTP 400 transport errors.
- Breaking change: clangd AI-first tools now use `filePath` input instead of `uri`.
- Added workspace-aware path parsing for `filePath`: `WorkspaceName/...` and absolute paths are accepted, `file:///...` is rejected.
- Switched `lm_clangd_typeHierarchy` output to AI summary text (`counts + --- + sections + entries`) and removed file coordinate JSON payload fields.
- Added AI-first symbol tools: `lm_clangd_symbolSearch`, `lm_clangd_symbolInfo`, `lm_clangd_symbolReferences`, `lm_clangd_symbolImplementations`, and `lm_clangd_callHierarchy`.
- Added `lm_clangd_symbolBundle` to aggregate symbol search/info/references/implementations/call-hierarchy into one AI-first call.
- Added `structuredContent` for clangd AI-first tools so clients can use stable machine-readable payloads alongside summary text.
- Unified clangd structured location fields to `absolutePath` (always) + `workspacePath` (nullable), with 1-based numeric coordinates and optional `preview`.
- Removed legacy structured path fields (`summaryPath`, `location.path#...`) and dropped raw input echo fields from AI-first structured payloads.
- Enhanced `lm_clangd_symbolSearch` to include full symbol signatures by default, using fallback chain `signatureHelp -> hover -> definitionLine`.
- Updated `lm_clangd_symbolInfo` snippet sourcing to exclude generated files (`*.generated.h`, `*.gen.cpp`) and no longer fallback to generated locations.
- Updated `lm_clangd_symbolInfo` to classify symbol category via document symbols and emit adaptive entries; `typeDefinition` is now included only when meaningful (for example value-like symbols).
- Updated `lm_clangd_typeHierarchy` SOURCE text order to `type -> preview -> path`, and added `preview` to `structuredContent.sourceByClass`.
- Updated `lm_clangd_typeHierarchy` source range strategy to rely on `textDocument/documentSymbol` only; when no matching symbol is found, output now falls back to single-line range (`endLine = startLine`).
- Disabled `lm_clangd_ast` exposure and removed it from default exposed/enabled clangd tool list.
- Updated `lm_clangd_status` and `lm_clangd_lspRequest` to return human-readable text content while preserving structured JSON objects in `structuredContent`.
- Updated LM tool forwarding output mapping: `LanguageModelDataPart` JSON object is now passed through as `structuredContent`, while `LanguageModelTextPart` is used for `content.text` to avoid duplicate wrapping.
- Refined LM forwarding mapping: `content.text` now only forwards `LanguageModelTextPart`, and JSON `LanguageModelDataPart` mime detection now accepts `application/json; charset=...` and `*+json` variants for `structuredContent`.
- Enforced `lmToolsBridge.useWorkspaceSettings` as workspace-only at runtime by auto-removing User-scope values and showing a warning.
- Added `Open Settings` action to the status menu for direct navigation to extension settings.
- Added a new custom diagnostics tool `lm_getDiagnostics` backed by `vscode.languages.getDiagnostics`, with stable structured output (`source/scope/severities/capped/totalDiagnostics/files`), optional `filePath` filter, severity/maxResults controls, no `uri` field in file entries, and per-diagnostic source preview (`startLine..endLine`, capped at 10 lines with availability/truncation flags).
- Updated `lm_clangd_typeHierarchy` to return a compact summary payload (`root`, `supers`, `derivedByParent`, `sourceByClass`, `limits`, `truncated`) with bounded expansion controls.
- Replaced `lm_clangd_typeHierarchy` input options `resolve/direction` with `maxSuperDepth`, `maxSubDepth`, and `maxSubBreadth`.
- Improved `sourceByClass.startLine` for Unreal C++ types: when the previous line is `UCLASS(...)` or `USTRUCT(...)`, the macro line is reported as the start line.
- Removed `lm_clangd_typeHierarchyResolve` from exposed clangd tools and dropped its dedicated implementation entrypoint.

### 中文

#### 变更
- 统一 `lm_findTextInFiles`、`lm_findFiles`、`lm_getDiagnostics` 的输出: `structuredContent` 固定为 JSON 对象,`content.text` 固定为人类可读摘要文本.
- 调整 find 摘要文本: 移除 `showing: x/y` 截断提示并改为分块格式(`---`、`// path:line`、预览另起一行),文件搜索改为输出完整路径列表.
- 调整 `lm_findFiles` 摘要路径行格式: 保留 `---` 分隔符,但路径行不再带 `//` 前缀.
- 修复握手 discovery 拉取 `tools/list` 的请求格式: 内部 JSON-RPC 请求改为有效 id(不再使用 `id: null`),在工作区工具可用时 `discovery.bridgedTools` 可正常填充.
- 调整 `lmToolsBridge.requestWorkspaceMCPServer` 的 tools/call 文本输出为人类可读多行摘要,同时保持 `structuredContent` 为完整 JSON 载荷.
- Breaking change: 从握手 discovery 的每工具条目中移除 `toolUri`/`schemaUri`,并新增 discovery 级 `resourceTemplates`(`lm-tools://tool/{name}`, `lm-tools://schema/{name}`)供客户端拼装 URI.
- 优化握手 discovery 的输入提示: manager 会读取 bridged tool 的 `lm-tools://schema/{name}` 推导真实 `Input: {...}` 签名,并移除误导性的 `Input: {}` 回退提示.
- discovery 诊断统一为 `discovery.issues` 分层结构(`level`、`category`、`code`、`message`、可选 `toolName/details`),同时承载 error 与 warning.
- discovery 中 schema 读取失败改为显式 `warning` issue(不再静默),并保持非阻断回退.
- 调整 `requestWorkspaceMCPServer` 的人类可读摘要文本: 在 `tools:` 下新增缩进的 bridged tool 名称列表,同时保持 `structuredContent` 不变.
- 将 `copilot_getErrors` 与 `copilot_readProjectStructure` 设为 built-in disabled(永不暴露/启用).
- 握手响应 discovery 改为精简结构(`callTool`, `bridgedTools`, `resourceTemplates`, `partial`, `issues`),减少 `lmToolsBridge.requestWorkspaceMCPServer` 之后的额外 list 调用.
- `discovery.partial` 现在仅由 `error` 级 issue 决定; `warning` 不会触发 partial.
- `discovery.callTool` 作为独立 manager 桥接工具返回并内联 `inputSchema`; `lmToolsBridge.requestWorkspaceMCPServer` 不再出现在 discovery 工具项中.
- `discovery.bridgedTools[].description` 在可用 schema 元数据时会追加简化 `Input: { ... }` 提示.
- `discovery` 不再返回 `resources`; 现在返回握手级 `resourceTemplates` 用于 URI 拼装.
- 调整 clangd 工具默认策略: 默认暴露,但不默认启用.
- 提升握手场景的会话健壮性: 当 `Mcp-Session-Id` 缺失或过期时,`lmToolsBridge.requestWorkspaceMCPServer` 现在会自动恢复新会话并返回新 session header,避免早期 HTTP 400 传输错误.
- Breaking change: clangd AI-first 工具输入从 `uri` 改为 `filePath`。
- 新增工作区感知 `filePath` 解析: 接受 `WorkspaceName/...` 和绝对路径,拒绝 `file:///...`。
- `lm_clangd_typeHierarchy` 输出切换为 AI 摘要文本(`counts + --- + sections + entries`),不再返回文件坐标 JSON 字段。
- 新增 AI-first 符号工具: `lm_clangd_symbolSearch`, `lm_clangd_symbolInfo`, `lm_clangd_symbolReferences`, `lm_clangd_symbolImplementations`, `lm_clangd_callHierarchy`。
- 新增 `lm_clangd_symbolBundle`,支持一次调用聚合 symbol search/info/references/implementations/call hierarchy。
- 为 clangd AI-first 工具补充 `structuredContent`,可在摘要文本之外提供稳定可机读载荷。
- 统一 clangd 结构化位置字段为 `absolutePath`(必有) + `workspacePath`(可空),并使用 1-based 数值坐标与可选 `preview`.
- 移除旧结构化路径字段(`summaryPath`, `location.path#...`),并清理 AI-first 结构化载荷中的输入回显字段.
- 增强 `lm_clangd_symbolSearch`,默认返回完整符号签名,并使用 `signatureHelp -> hover -> definitionLine` 回退链路.
- 调整 `lm_clangd_symbolInfo` snippet 选点规则: 默认排除 generated 文件(`*.generated.h`, `*.gen.cpp`),且不再回退到 generated 位置.
- 更新 `lm_clangd_symbolInfo`: 基于 document symbols 做符号类别判定并自适应输出条目; `typeDefinition` 仅在有意义场景(如 value-like 符号)返回.
- 调整 `lm_clangd_typeHierarchy` 的 SOURCE 文本顺序为 `type -> preview -> path`,并在 `structuredContent.sourceByClass` 新增 `preview` 字段.
- 调整 `lm_clangd_typeHierarchy` 区间策略为仅依赖 `textDocument/documentSymbol`; 未命中匹配符号时回退为单行区间(`endLine = startLine`),不再使用本地大括号扫描.
- 禁用 `lm_clangd_ast` 暴露并将其从 clangd 默认 exposed/enabled 列表移除.
- 将 `lm_clangd_status` 与 `lm_clangd_lspRequest` 的 `content` 调整为人类可读文本,同时保留 `structuredContent` 结构化对象.
- 调整 LM tool 转发输出映射: `LanguageModelDataPart` 的 JSON object 直通 `structuredContent`,`LanguageModelTextPart` 仅作为 `content.text`,避免重复包装.
- 细化 LM tool 转发映射: `content.text` 仅透传 `LanguageModelTextPart`,并增强 `LanguageModelDataPart` 的 JSON mime 识别(`application/json; charset=...` 与 `*+json` 变体)以稳定透传 `structuredContent`.
- 在运行时将 `lmToolsBridge.useWorkspaceSettings` 强制为仅工作区级: 若出现在 User 级会自动移除并提示.
- 在状态菜单新增 `Open Settings` 操作,可直接跳转到扩展设置页.
- 新增自定义诊断工具 `lm_getDiagnostics`,基于 `vscode.languages.getDiagnostics` 输出稳定结构化结果(`source/scope/severities/capped/totalDiagnostics/files`),并支持 `filePath` 过滤与 severity/maxResults 控制; 文件项不再包含 `uri`,且每条诊断附带 `startLine..endLine` 代码预览(最多 10 行,带可用性/截断标记).
- 更新 `lm_clangd_typeHierarchy` 输出为汇总结构(`root`, `supers`, `derivedByParent`, `sourceByClass`, `limits`, `truncated`),并支持有界展开。
- 将 `lm_clangd_typeHierarchy` 入参从 `resolve/direction` 调整为 `maxSuperDepth`, `maxSubDepth`, `maxSubBreadth`。
- 优化 Unreal C++ 类型的 `sourceByClass.startLine`: 当前一行是 `UCLASS(...)` 或 `USTRUCT(...)` 宏时,起始行会上移到宏所在行。
- 移除 `lm_clangd_typeHierarchyResolve` 的 clangd 工具暴露及其独立实现入口。

## [1.0.67] - 2026-02-10

### English

#### Changed
- Breaking change: renamed custom diagnostics tool from `lm_getErrors` to `lm_getDiagnostics`.
- No compatibility alias is provided; callers and local settings must migrate to `lm_getDiagnostics` manually.
- Kept tool behavior and payload schema unchanged (`filePath`/`severities`/`maxResults` input and diagnostics summary + structured payload output).

### 中文

#### 变更
- Breaking change: 自定义诊断工具由 `lm_getErrors` 更名为 `lm_getDiagnostics`。
- 不提供兼容 alias; 外部调用和本地配置需手动迁移到 `lm_getDiagnostics`。
- 保持工具行为和输出结构不变(输入仍为 `filePath`/`severities`/`maxResults`,输出仍为诊断摘要与结构化载荷)。

## [1.0.61] - 2026-02-07

### English

#### Changed
- Improved exposure-panel read-only affordance: `Always Exposed` and `Built-in Disabled` tools now use distinct color accents and badges for faster visual recognition.
- Hid group-level checkboxes for fully read-only groups to reduce visual noise in `Built-in Disabled` sections.
- Reworked `README.md` into a bilingual English/Chinese format and aligned it with current implementation details.
- Clarified Manager-to-workspace MCP server relationship in README and documented the recommended client connection flow (`Manager /mcp` + workspace handshake).
- Added a user-facing README section for multi-instance port avoidance and re-routing behavior, including `POST /allocate` reservation and runtime `EADDRINUSE` retry semantics.

### 中文

#### 变更
- 改进 Exposure 面板只读项的可视化区分: `Always Exposed` 与 `Built-in Disabled` 使用了更明显的颜色和 badge.
- 对全只读分组隐藏组级复选框,减少 `Built-in Disabled` 区域的视觉噪音.
- 将 `README.md` 重构为中英双语格式,并与当前实现细节完成对齐.
- 在 README 中补充 Manager 与工作区 MCP server 的关系说明,并给出推荐客户端连接流程(`Manager /mcp` + 工作区握手).
- 在 README 中新增多实例端口避让与重路由说明,覆盖 `POST /allocate` 保留分配和运行时 `EADDRINUSE` 递增重试语义.

## [1.0.60] - 2026-02-07

### English

#### Changed
- Added an isolated `src/clangd/` module for clangd MCP integration with low coupling to `tooling.ts`.
- Added configurable clangd MCP settings: `clangd.enabled`, `clangd.autoStartOnInvoke`, `clangd.enablePassthrough`, `clangd.requestTimeoutMs`, and `clangd.allowedMethods`.
- Added `lm_clangd_*` tools for status, switch header/source, AST, type hierarchy, memory usage, inlay hints, and restricted passthrough requests.
- Added auto-start-on-invoke behavior that triggers `clangd.activate` when clangd tools are enabled and the client is unavailable.
- Restricted `lm_clangd_lspRequest` to read-only passthrough methods and ignore non-read-only configured methods.
- Pruned low-value clangd tool exposure by removing default exposure of `lm_clangd_memoryUsage` and `lm_clangd_inlayHints`.
- Trimmed read-only passthrough defaults by removing `textDocument/completion`, `textDocument/semanticTokens/full`, `$/memoryUsage`, and `clangd/inlayHints`.
- Switched clangd tool position semantics to 1-based line/character for human-facing input and output, with automatic conversion at the LSP boundary.
- Added `clangd-mcp-implementation-guide.md` as the implementation and progress tracking guide.
- Replaced QuickPick tool configuration pages with a grouped tree webview panel for both exposure tools and enabled tools, with collapse, group batch selection, search, and reset/confirm/cancel actions.
- Added resilient fallback to legacy QuickPick configuration when the webview path fails.
- Reworked tool selection into a two-layer `exposure + enabled` model with new settings: `tools.exposedDelta` and `tools.unexposedDelta`.
- Replaced command IDs `lm-tools-bridge.configureTools` and `lm-tools-bridge.configureBlacklist` with `lm-tools-bridge.configureExposure` and `lm-tools-bridge.configureEnabled`.
- Removed `tools.blacklist` and `tools.blacklistPatterns`, and now auto-clears legacy values on activation.
- Enforced strong consistency: when a tool becomes unexposed, its `enabledDelta` and `disabledDelta` entries are automatically pruned.
- Enforced required exposure for built-in default-enabled tools and rendered them as read-only (disabled checkbox) in the exposure panel.
- Restored built-in disabled hard rules: disabled tools are moved to a bottom `Built-in Disabled` parent group with source child groups in exposure, are read-only, never appear in enabled, and are auto-pruned from all four delta settings.
- Added `copilot_askQuestions`, `copilot_readNotebookCellOutput`, `copilot_switchAgent`, `copilot_toolReplay`, and `search_subagent` to the built-in disabled list.
- Added a dedicated `AngelScript` group for tools with the `angelscript_` prefix in the configuration UI.
- Replaced hardcoded `angelscript_` grouping with configurable regex rules via `tools.groupingRules` (built-in disabled > custom rules > built-in groups).
- Added a default `Clangd` custom grouping rule (`^lm_clangd_`) so clangd tools appear in their own top-level group by default.

#### Fixed
- Fixed blank tool-configuration webview caused by invalid JSON state serialization in the embedded `application/json` script block.

### 中文

#### 变更
- 新增独立 `src/clangd/` 模块,用于低耦合集成 clangd MCP 能力,降低对 `tooling.ts` 的耦合.
- 新增可配置 clangd MCP 设置: `clangd.enabled`, `clangd.autoStartOnInvoke`, `clangd.enablePassthrough`, `clangd.requestTimeoutMs`, `clangd.allowedMethods`.
- 新增 `lm_clangd_*` 工具,覆盖 status, switch header/source, AST, type hierarchy, memory usage, inlay hints,以及受限 passthrough 请求.
- 新增按需自动启动逻辑: clangd 工具调用时客户端不可用则触发 `clangd.activate`.
- 限制 `lm_clangd_lspRequest` 仅允许只读 passthrough 方法,并忽略非只读配置方法.
- 剪裁低价值 clangd 工具默认暴露,移除 `lm_clangd_memoryUsage` 与 `lm_clangd_inlayHints` 的默认暴露.
- 精简只读 passthrough 默认方法,移除 `textDocument/completion`, `textDocument/semanticTokens/full`, `$/memoryUsage`, `clangd/inlayHints`.
- 将 clangd 工具的行列位置语义统一为 1-based 输入输出,并在 LSP 边界自动转换.
- 新增 `clangd-mcp-implementation-guide.md` 作为实施与进度跟踪指南.
- 将 Exposure/Enabled 配置 UI 从 QuickPick 替换为分组树形 webview,支持折叠,分组批量勾选,搜索,以及 reset/confirm/cancel.
- 增加 webview 失败时回退到 legacy QuickPick 的兜底路径.
- 将工具选择模型重构为双层 `exposure + enabled`,新增 `tools.exposedDelta` 与 `tools.unexposedDelta`.
- 将命令 ID 从 `lm-tools-bridge.configureTools` 和 `lm-tools-bridge.configureBlacklist` 替换为 `lm-tools-bridge.configureExposure` 和 `lm-tools-bridge.configureEnabled`.
- 移除 `tools.blacklist` 与 `tools.blacklistPatterns`,并在激活时自动清理 legacy 值.
- 强化一致性规则: 工具变为 unexposed 时,自动清理其 `enabledDelta` 和 `disabledDelta` 项.
- 对默认启用工具强制暴露,并在 Exposure 面板中以只读复选框呈现.
- 恢复 built-in disabled 硬规则: 禁用工具移入底部 `Built-in Disabled` 父分组及其来源子分组,只读显示,不会出现在 Enabled,并会从四个 delta 配置自动清理.
- 将 `copilot_askQuestions`, `copilot_readNotebookCellOutput`, `copilot_switchAgent`, `copilot_toolReplay`, `search_subagent` 加入 built-in disabled 列表.
- 新增 `angelscript_` 前缀工具专用 `AngelScript` 分组.
- 将 `angelscript_` 硬编码分组替换为 `tools.groupingRules` 正则规则分组(优先级: built-in disabled > custom rules > built-in groups).
- 新增默认 `Clangd` 分组规则(`^lm_clangd_`),使 clangd 工具默认显示在独立顶层分组.

#### 修复
- 修复工具配置 webview 为空白的问题,原因是嵌入 `application/json` 脚本块时状态序列化无效.

## [1.0.59] - 2026-02-03

### English

#### Changed
- Updated `tools.schemaDefaults` setting defaults and examples.

### 中文

#### 变更
- 更新 `tools.schemaDefaults` 配置的默认值与示例.

## [1.0.58] - 2026-02-03

### English

#### Changed
- Added `tools.enabledDelta` / `tools.disabledDelta` to the settings UI and removed `lmToolsBridge.tools.enabled`.
- Removed conflicting built-in blacklist entries so default enabled tools can be configured correctly.
- Automatically clears legacy `lmToolsBridge.tools.enabled` values on activation.
- Reduced the default enabled tool list (removed tests, changed files, and terminal tools).

### 中文

#### 变更
- 在设置 UI 中新增 `tools.enabledDelta` / `tools.disabledDelta`,并移除 `lmToolsBridge.tools.enabled`.
- 移除与默认启用列表冲突的 built-in blacklist 项,确保默认启用工具可被正确配置.
- 激活时自动清理 legacy `lmToolsBridge.tools.enabled` 值.
- 收紧默认启用工具列表(移除 tests, changed files, terminal 相关工具).

## [1.0.57] - 2026-02-03

### English

#### Changed
- Removed the legacy `lmToolsBridge.tools.enabled` setting from configuration UI. Use `tools.enabledDelta` / `tools.disabledDelta` instead.

### 中文

#### 变更
- 从配置 UI 移除 legacy `lmToolsBridge.tools.enabled` 设置,改用 `tools.enabledDelta` / `tools.disabledDelta`.

## [1.0.56] - 2026-02-03

### English

#### Changed
- Added `includeIgnoredFiles` to `lm_findFiles` (schema + rg flags).
- Applied include globs before exclude globs in `lm_findTextInFiles` and `lm_findFiles` so excludes still take effect.

### 中文

#### 变更
- 为 `lm_findFiles` 新增 `includeIgnoredFiles` 支持(schema + rg flags).
- 在 `lm_findTextInFiles` 和 `lm_findFiles` 中调整为先应用 include globs,再应用 exclude globs,确保 exclude 仍然生效.

## [1.0.55] - 2026-02-03

### English

#### Changed
- Merged workspace and folder `search.exclude` / `files.exclude` so `.code-workspace` exclusions are honored.
- Unified exclusion configuration for `lm_findTextInFiles` and `lm_findFiles`.

### 中文

#### 变更
- 合并 workspace 与 folder 的 `search.exclude` / `files.exclude`,确保 `.code-workspace` 排除规则被正确应用.
- 统一 `lm_findTextInFiles` 与 `lm_findFiles` 的排除配置逻辑.

## [1.0.54] - 2026-02-02

### English

#### Changed
- Switched `lm_findFiles` backend to ripgrep (`rg --files`) for consistent file discovery.
- Reworked tool enablement storage to `tools.enabledDelta` + `tools.disabledDelta` relative to defaults.
- Default enabled tools now use `lm_findFiles` / `lm_findTextInFiles`; set `lm_findFiles.maxResults=200` by default.

### 中文

#### 变更
- 将 `lm_findFiles` 后端切换为 ripgrep(`rg --files`),统一文件发现行为.
- 将工具启用状态存储重构为相对默认值的 `tools.enabledDelta` + `tools.disabledDelta`.
- 默认启用工具改为 `lm_findFiles` / `lm_findTextInFiles`,并将 `lm_findFiles.maxResults` 默认设为 200.

## [1.0.53] - 2026-02-01

### English

#### Changed
- Enabled `copilot_findFiles` and `copilot_findTextInFiles` by default.
- Removed copilot find tools from the built-in blacklist while keeping schema default overrides.

### 中文

#### 变更
- 默认启用 `copilot_findFiles` 与 `copilot_findTextInFiles`.
- 在保留 schema 默认覆盖规则的同时,将 copilot find 工具移出 built-in blacklist.

## [1.0.52] - 2026-01-31

### English

#### Changed
- Refined schema discovery guidance: keep schema entries template-only in `resources/list`.
- Clarified handshake flow to read `lm-tools://schema/{name}` once before the first tool call.

### 中文

#### 变更
- 优化 schema 发现指引: 在 `resources/list` 中保持 schema 条目为 template-only.
- 明确握手流程: 首次调用工具前先读取一次 `lm-tools://schema/{name}`.

## [1.0.51] - 2026-01-31

### English

#### Changed
- Expanded handshake resource guidance and added rebind hints for expired sessions.

### 中文

#### 变更
- 扩展 handshake 资源指引,并补充会话过期后的 rebind 提示.

## [1.0.50] - 2026-01-31

### English

#### Changed
- Improved MCP discovery and handshake SSE behavior.
- Listed schema resources after handshake and returned MethodNotFound for unknown tools.
- Sent `resources/tools list_changed` notifications via SSE to trigger client refresh.
- Formalized the Manager control endpoint (default `47100`) as the handshake/status entry point.

### 中文

#### 变更
- 改进 MCP discovery 与 handshake 的 SSE 行为.
- 握手后列出 schema 资源,并对未知工具返回 MethodNotFound.
- 通过 SSE 发送 `resources/tools list_changed` 通知,触发客户端刷新.
- 将 Manager 控制端点(默认 `47100`)标准化为握手与状态入口.

## [1.0.49] - 2026-01-31

### English

#### Changed
- Latest release branch baseline used for this changelog.

### 中文

#### 变更
- 本 changelog 的 release 分支基线版本.
