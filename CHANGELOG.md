# Changelog

All notable changes to this project are documented in this file.

Maintenance rule:
- For each release, keep both `### English` and `### 中文` sections.
- Keep section order aligned to reduce translation drift.

## [1.0.91] - 2026-02-14

### English

#### Changed
- Standardized path contract for built-in `lm_*` custom tools: `structuredContent` now uses absolute paths for path fields.
- Updated `content.text` path rendering for `lm_findFiles`, `lm_findTextInFiles`, and `lm_getDiagnostics`: prefer workspace-style paths (`WorkspaceName/...`) and fall back to absolute paths when workspace mapping is unavailable.

### 中文

#### 变更
- 统一内置 `lm_*` 自定义工具的路径约定: `structuredContent` 中的路径字段现在使用绝对路径.
- 调整 `lm_findFiles`,`lm_findTextInFiles`,`lm_getDiagnostics` 的 `content.text` 路径展示: 优先显示工作区路径(`WorkspaceName/...`),工作区无法匹配时回退为绝对路径.

## [1.0.90] - 2026-02-13

### English

#### Changed
- Added `Config scope` to the status bar tooltip to show the currently effective lmToolsBridge settings read location.

### 中文

#### 变更
- 状态栏 tooltip 新增 `Config scope`,用于显示当前生效的 lmToolsBridge 配置读取位置.

## [1.0.89] - 2026-02-13

### English

#### Changed
- Fixed workspace settings scope resolution for `.code-workspace`: when `lmToolsBridge.useWorkspaceSettings` is enabled, lmToolsBridge settings now read from and write to the workspace file (Workspace target) instead of folder settings.

### 中文

#### 变更
- 修复 `.code-workspace` 下的 workspace 配置作用域解析: 当启用 `lmToolsBridge.useWorkspaceSettings` 时, lmToolsBridge 配置现在会直接读写 workspace 文件(Workspace target),不再写入 folder settings.

## [1.0.88] - 2026-02-13

### English

#### Changed
- Added a `copilot_searchCodebase` response guard in LM passthrough: when `content.text` contains `Here are the full contents of the text files in my workspace:`, the bridge now returns an unavailable error and advises not retrying unless explicitly requested by the user.

### 中文

#### 变更
- 在 LM passthrough 中为 `copilot_searchCodebase` 增加返回保护: 当 `content.text` 包含 `Here are the full contents of the text files in my workspace:` 时,bridge 现在返回工具不可用错误,并提示除非用户明确要求否则不要重试.

## [1.0.87] - 2026-02-13

### English

#### Changed
- Refactored manager status handling into dedicated modules: status types moved to `managerStatusTypes.ts`, payload assembly moved to `managerStatusService.ts`, and `manager.ts` now keeps only status route orchestration.
- Refactored manager log handling into dedicated modules: logger state/write flow moved to `managerLogger.ts`, `/mcp/log` page rendering moved to `managerLogPage.ts`, and `manager.ts` now uses injected handlers.
- Kept `/mcp/status` and `/mcp/log` response contracts unchanged while reducing `manager.ts` responsibility and improving maintainability.

### 中文

#### 变更
- 重构 manager status 模块: 状态类型迁移到 `managerStatusTypes.ts`, payload 组装迁移到 `managerStatusService.ts`, `manager.ts` 仅保留 status 路由编排职责.
- 重构 manager log 模块: 日志状态与写入流程迁移到 `managerLogger.ts`, `/mcp/log` 页面渲染迁移到 `managerLogPage.ts`, `manager.ts` 改为通过注入处理器调用.
- 保持 `/mcp/status` 与 `/mcp/log` 对外响应契约不变, 同时降低 `manager.ts` 职责并提升可维护性.

## [1.0.86] - 2026-02-13

### English

#### Changed
- Breaking change: `lm_getDiagnostics` input migrated from `filePath` to `filePaths` (`string[]`); legacy `filePath` is now ignored.
- `lm_getDiagnostics` now supports multi-file filtering with `filePaths` and keeps path parsing behavior aligned with workspace-aware resolution (`WorkspaceName/...` and absolute paths).
- `lm_getDiagnostics` structured payload `scope` now includes `multi-file` in addition to `workspace+external` and `single-file`.
- Updated `lm_getDiagnostics` default `maxResults` from `500` to `100`.
- Updated `lm_getDiagnostics` input behavior: unknown fields are ignored, `severities` now matches case-insensitively with normalization dedupe, and `maxResults` remains strict (`integer >= 1`).
- Updated documentation (`README.md`, `face-ai-report.md`) to match the new diagnostics input contract and failure cases.
- Refactored manager session strategy to single-source IDs for handshake recovery: when `requestWorkspaceMCPServer` sees an unknown session, manager now creates the session using the client-provided `Mcp-Session-Id` instead of generating a replacement id.
- Removed manager `session alias` and `session archive` compatibility layers, including stale-to-active mapping, archive persistence/rebind paths, and related status observability fields.
- Removed `lmToolsBridge.manager.sessionArchiveAutoRebind` setting and manager startup flags `--state-dir` / `--session-archive-auto-rebind`.
- Updated session header behavior: only `initialize` responses set `Mcp-Session-Id`; non-`initialize` responses no longer set this header.
- Kept unknown-session behavior strict for non-handshake requests: manager returns `Unknown Mcp-Session-Id` and requires handshake.
- Handshake result payload continues to include `mcpSessionId` for diagnostics.
- Standardized roots behavior to MCP client-capability direction: manager now issues server-initiated `roots/list` requests after `notifications/initialized` and `notifications/roots/list_changed` when client declares `capabilities.roots`.
- Added roots observability fields to `/mcp/status` (`rootsPolicy` and per-session roots sync state) and roots lifecycle logs (`roots.capability`, `roots.list.request/result/error/skip/timeout`) to `/mcp/log`.
- Added detailed client capability snapshot to `/mcp/status` as `sessionDetails[].clientCapabilities` (captured from `initialize.params.capabilities`) for easier roots/debug compatibility diagnosis.
- Replaced hardcoded per-capability status fields with auto-derived capability summaries in `/mcp/status`: `sessionDetails[].clientCapabilityFlags` and `sessionDetails[].clientCapabilityObjectKeys`.
- Clarified `/mcp/status` HTML session labels: `Instances` now shows `VS Code Instance Session ID`, and `Sessions` now shows `MCP Session ID`; session target text now prefixes `vscodeInstanceSessionId=...` to reduce ambiguity.
- Updated `/mcp/status` long-cell behavior: removed per-cell `Expand/Collapse` controls, and long values now render as full multi-line text by default.
- Reduced manager `/mcp/log` request noise: `[request]` lines now only log MCP business ingress (`POST /mcp`, `DELETE /mcp`), while observability/probe requests (`GET /mcp/status`, `GET /mcp/log`, `/.well-known/*`, and other non-`/mcp` requests) are excluded.
- Breaking change: removed non-standard client-driven `roots/list` behavior on manager; direct client calls now return `MethodNotFound`.

### 中文

#### 变更
- Breaking change: `lm_getDiagnostics` 输入由 `filePath` 迁移为 `filePaths`(`string[]`); 旧字段 `filePath` 现在会被忽略.
- `lm_getDiagnostics` 新增 `filePaths` 多文件过滤能力,并保持工作区感知路径解析行为(`WorkspaceName/...` 和绝对路径).
- `lm_getDiagnostics` 结构化输出 `scope` 新增 `multi-file`,并继续保留 `workspace+external` 与 `single-file`.
- 将 `lm_getDiagnostics` 默认 `maxResults` 从 `500` 调整为 `100`.
- 调整 `lm_getDiagnostics` 输入行为: 未定义字段改为忽略,`severities` 改为大小写不敏感并在归一化后去重,`maxResults` 继续保持严格校验(必须为 >= 1 的整数).
- 同步更新文档(`README.md`,`face-ai-report.md`),对齐新的诊断工具输入约定与失败路径.
- 将 manager 会话策略重构为单一 ID 来源: `requestWorkspaceMCPServer` 遇到未知会话时,直接使用客户端传入的 `Mcp-Session-Id` 建立会话,不再生成替代 id.
- 移除 manager 的 `session alias` 与 `session archive` 兼容层,包括 stale->active 映射、archive 持久化/rebind 路径及其状态观测字段.
- 移除 `lmToolsBridge.manager.sessionArchiveAutoRebind` 配置项,并删除 manager 启动参数 `--state-dir` 与 `--session-archive-auto-rebind`.
- 调整会话响应头行为: 仅 `initialize` 响应返回 `Mcp-Session-Id`; 非 `initialize` 响应不再返回该 header.
- 保持 non-handshake 请求的未知会话严格错误行为: 返回 `Unknown Mcp-Session-Id` 并要求先握手.
- 握手结果 payload 继续返回 `mcpSessionId` 用于诊断观测.
- 将 roots 行为标准化为 MCP 客户端能力方向: 当客户端在 `initialize` 声明 `capabilities.roots` 时,manager 会在 `notifications/initialized` 和 `notifications/roots/list_changed` 后发起 `server -> client` 的 `roots/list` 请求.
- 为 roots 同步新增可观测性: `/mcp/status` 增加 `rootsPolicy` 与 session roots 同步字段,`/mcp/log` 增加 `roots.capability` 与 `roots.list.request/result/error/skip/timeout` 日志.
- 为 `/mcp/status` 增加详细客户端能力快照 `sessionDetails[].clientCapabilities`(来自 `initialize.params.capabilities`),用于更直观地定位 roots/兼容性问题.
- 将 `/mcp/status` 中按 capability 逐项硬编码的字段改为自动推导汇总: `sessionDetails[].clientCapabilityFlags` 与 `sessionDetails[].clientCapabilityObjectKeys`.
- 明确 `/mcp/status` HTML 中的 session 标识: `Instances` 表头改为 `VS Code Instance Session ID`,`Sessions` 表头改为 `MCP Session ID`,并在 `Target` 文本前缀 `vscodeInstanceSessionId=...` 以减少歧义.
- 调整 `/mcp/status` 长文本行为: 移除单元格 `Expand/Collapse` 交互,长文本默认完整多行展示.
- 降低 manager `/mcp/log` 的 request 噪声: `[request]` 日志现在仅记录 MCP 业务入口(`POST /mcp`,`DELETE /mcp`),观测与探测请求(`GET /mcp/status`,`GET /mcp/log`,`/.well-known/*` 及其他非 `/mcp` 请求)不再输出 request 行.
- Breaking change: 移除 manager 上非标准的 client 主动 `roots/list` 语义; 直接调用该方法现在返回 `MethodNotFound`.

## [1.0.83] - 2026-02-12

### English

#### Changed
- Improved `workspaceFolder` path matching for task/debug tools to be platform-aware: Windows path comparison is case-insensitive, while POSIX comparison keeps case sensitivity.
- Updated task selection for `lm_tasks_runBuild` and `lm_tasks_runTest` in multi-root workspaces: when `workspaceFolder` is provided, selection now prefers folder-scoped tasks and falls back to workspace-scoped tasks.
- Expanded `lm_debug_listLaunchConfigs` and `lm_debug_start` launch config discovery to include both workspace-folder launch settings and workspace-level launch settings.
- Tightened `lm_debug_start` name-based selection: when `name` matches multiple launch configs, the tool now returns an explicit ambiguity error and asks callers to disambiguate with `index` or `workspaceFolder`.
- Debug tool summaries now include launch config scope (`workspaceFolder` or `workspace`) and workspace folder path when available.
- Deprecated and hard-disabled all `lm_clangd_*` MCP tools in runtime registration; clangd tools can no longer be enabled by settings.
- Removed user-facing `lmToolsBridge.clangd.*` enablement settings from extension configuration contributions.
- Marked `copilot_findFiles` and `copilot_findTextInFiles` as built-in disabled tools; they are now always blocked from exposure/enabling/calling.
- Removed implementation-layer `copilot_find*` special handling in `tooling.ts` (schema default overrides and `copilot_findTextInFiles` schema/text normalization branches), while keeping `lm_find*` behavior unchanged.
- Clarified `lm_findFiles` and `lm_findTextInFiles` schema/description guidance: both now explicitly document `WorkspaceName/**` style scoping for multi-root workspace targeting.
- Removed unused helper functions and no-op schema patch branches in `searchTools.ts` and `tooling.ts` without behavior changes.

### 中文

#### 变更
- 改进 task/debug 工具的 `workspaceFolder` 路径匹配为平台感知: Windows 路径比较大小写不敏感,POSIX 路径比较保持大小写敏感.
- 调整 `lm_tasks_runBuild` 与 `lm_tasks_runTest` 在 multi-root 下的选择策略: 当传入 `workspaceFolder` 时,优先选择该 folder 作用域 task,并回退到 workspace 作用域 task.
- 扩展 `lm_debug_listLaunchConfigs` 与 `lm_debug_start` 的 launch 配置发现范围: 同时覆盖 workspace-folder launch 配置和 workspace 级 launch 配置.
- 收紧 `lm_debug_start` 按 `name` 的选择行为: 当 `name` 命中多个 launch 配置时,返回明确歧义错误,并提示调用方使用 `index` 或 `workspaceFolder` 消歧.
- debug 工具摘要新增配置作用域(`workspaceFolder` 或 `workspace`)和可用的 workspace folder 路径信息.
- 将 `lm_clangd_*` MCP 工具标记为弃用并在运行时硬禁用,不再允许通过设置开启 clangd 工具.
- 从扩展配置贡献中移除面向用户的 `lmToolsBridge.clangd.*` 启用类设置项.
- 将 `copilot_findFiles` 与 `copilot_findTextInFiles` 标记为 built-in disabled 工具,并统一阻断 exposed/enabled/call.
- 移除 `tooling.ts` 中针对 `copilot_find*` 的实现层特判(默认 schema override 与 `copilot_findTextInFiles` 的 schema/text normalize 分支),同时保持 `lm_find*` 行为不变.
- 补充 `lm_findFiles` 与 `lm_findTextInFiles` 的 schema/description 文案: 显式说明可使用 `WorkspaceName/**` 形式在 multi-root 中限定目标工作区.
- 删除 `searchTools.ts` 与 `tooling.ts` 中未使用 helper 与 no-op schema patch 分支,不改变运行行为.

## [1.0.79] - 2026-02-12

### English

#### Changed
- Clarified `lmToolsBridge.tools.schemaDefaults` setting description in VS Code UI examples: examples now show entry values directly (without outer quotes and JSON-style escape sequences) to reduce confusion.
- Added `Open Extension Page` action under the status menu so users can jump directly to this extension page in VS Code Extensions.
- Hardened `Restart Manager` for single-instance-priority recovery: manual restart now uses a longer lock wait window, lock owner diagnostics, and stale-lock cleanup based on `pid + age` instead of mtime-only checks.
- Added explicit manual restart failure classification and guidance (`other_instance_lock`, `manager_shutdown_failed`, `manager_start_failed`) to avoid silent failures.
- Status menu now logs restart summary lines (`restart-manager result=success|failed reason=...`) for faster diagnosis.
- Status bar tooltip now includes a compact manager ownership summary sourced from internal manager pipe calls (`GET /health`, `GET /list`) with `/mcp/status` fallback, using line/length budgets to avoid oversized output.
- Version-upgrade restart now automatically runs when `extensionVersion > managerVersion`, and uses the same core restart flow as status-menu `Restart Manager` to avoid branch divergence.
- Added a dedicated timeout failure notification for upgrade restarts: when upgrade restart times out, users are explicitly told to run `Restart Manager` manually from the status menu.
- Restart progress UI now uses the extension status bar item spinner (`$(sync~spin)`) for all restart sources, removing restart-time overlay progress.
- Added asymmetric status-bar settle timing after restart completion: success stays briefly (~1 second) while failure stays longer (~8 seconds), with notifications kept.
- Increased manager idle self-shutdown grace window from 3 seconds to 10 seconds.
- Increased old-manager shutdown wait timeout in restart flow from 3 seconds to 5 seconds.
- Relaxed manager instance liveness TTL from 1.5 seconds to 2.5 seconds to reduce false stale detection during heartbeat jitter.
- Updated `/mcp/status` to support content negotiation: browser requests now get a human-readable HTML dashboard with `Refresh` and `Auto refresh (2s)`, while programmatic requests keep JSON compatibility (`?format=json`, `?format=html`).
- Added first-batch non-interactive task/debug tools: `lm_tasks_runBuild`, `lm_tasks_runTest`, `lm_debug_listLaunchConfigs`, and `lm_debug_start`.
- New task/debug tools are exposed by default but remain disabled by default, so users can opt in from enabled-tools settings.

### 中文

#### 变更
- 澄清 VS Code UI 中 `lmToolsBridge.tools.schemaDefaults` 的示例文案: 示例现在直接展示 entry 值(不再使用外层引号和 JSON 风格转义),以减少误导.
- 在状态菜单中新增 `Open Extension Page` 操作,可直接跳转到 VS Code Extensions 中的本扩展页面.
- 强化 `Restart Manager` 的单实例优先恢复能力: 手动重启使用更长锁等待窗口,增加锁归属诊断,并将陈旧锁判定由仅 mtime 升级为 `pid + age`.
- 为手动重启补充明确失败分型与提示(`other_instance_lock`,`manager_shutdown_failed`,`manager_start_failed`),避免 silent fail.
- 状态菜单重启后新增摘要日志(`restart-manager result=success|failed reason=...`),便于快速定位问题.
- 状态栏 tooltip 新增精简 manager 归属摘要: 以内置 manager pipe(`GET /health`,`GET /list`)为主数据源,`/mcp/status` 为回退,并通过行数/长度预算避免信息过载.
- 当 `extensionVersion > managerVersion` 时,版本升级重启改为自动触发,并与状态菜单 `Restart Manager` 统一使用同一核心重启流程,避免分支行为不一致.
- 为升级重启增加超时专用提示: 当升级重启超时时,会明确提示用户从状态菜单手动执行 `Restart Manager`.
- 所有重启来源(菜单重启和自动升级重启)的进度展示统一改为扩展状态栏转圈(`$(sync~spin)`),移除重启过程覆盖层进度提示.
- 重启结束后状态栏结果停留改为非对称时长: 成功短暂停留(约 1 秒),失败长时间停留(约 8 秒),同时继续保留成功/失败通知提示.
- 将 manager 空闲自退出窗口从 3 秒提升到 10 秒.
- 将重启流程中等待旧 manager 退出超时从 3 秒提升到 5 秒.
- 将 manager 实例存活 TTL 从 1.5 秒放宽到 2.5 秒,降低 heartbeat 抖动时的误判下线.
- 更新 `/mcp/status` 为内容协商模式: 浏览器请求可获得人类可读 HTML 仪表页(含 `Refresh` 与 `Auto refresh (2s)`),程序化请求继续保持 JSON 兼容(`?format=json`,`?format=html`).
- 新增首批非交互 task/debug 工具: `lm_tasks_runBuild`,`lm_tasks_runTest`,`lm_debug_listLaunchConfigs`,`lm_debug_start`.
- 新增 task/debug 工具默认 exposed,但默认不 enabled,用户可按需在 enabled 工具设置中开启.

## [1.0.76] - 2026-02-11

### English

#### Changed
- Breaking change: removed legacy custom-tool compatibility payload mapping (`CustomToolInvokePayload`), and now require custom tools to return `LanguageModelToolResult` directly.
- Built-in custom tools (`lm_find*`, `lm_getDiagnostics`, `lm_clangd_*`) now provide explicit dual-channel outputs from tool implementations: `content.text` and `structuredContent`.
- Tightened forwarded LM tool mapping (`lm.invokeTool`): `content.text` is emitted only from upstream text parts, and `structuredContent` is emitted only for valid JSON object payloads; no cross-channel fallback copy is performed.
- Removed structured fallback wrapper generation (`{ blocks: [...] }`) for forwarded LM tool results when no valid structured object exists.
- Updated `lm_clangd_inlayHints` to include structured payload alongside summary text.

### 中文

#### 变更
- Breaking change: 移除旧的自定义工具兼容返回形态(`CustomToolInvokePayload`),并统一要求自定义工具直接返回 `LanguageModelToolResult`.
- 内置自定义工具(`lm_find*`,`lm_getDiagnostics`,`lm_clangd_*`)现在由工具实现端显式提供双通道输出:`content.text` 与 `structuredContent`.
- 收紧上游 LM 工具转发映射(`lm.invokeTool`): `content.text` 仅在上游 text part 存在时输出,`structuredContent` 仅在上游返回合法 JSON object 时输出; 不再做跨通道回填复制.
- 移除上游 LM 工具结果在缺失 structured object 时的结构化回退包装(`{ blocks: [...] }`).
- 为 `lm_clangd_inlayHints` 补充 structured payload,与摘要文本同时返回.

## [1.0.74] - 2026-02-11

### English

#### Changed
- Breaking change: removed `lmToolsBridge.tools.responseFormat` from extension settings; output mode is no longer user-configurable.
- MCP tool-call responses are now fixed to return both `content.text` and `structuredContent` for success and error payloads.
- Updated docs (`README.md`, `face-ai-report.md`) to reflect the fixed dual-channel output behavior.

### 中文

#### 变更
- Breaking change: 从扩展设置中移除 `lmToolsBridge.tools.responseFormat`,不再支持用户切换输出模式.
- MCP tools/call 响应现在固定同时返回 `content.text` 与 `structuredContent`,成功与错误返回均保持双通道.
- 同步更新文档(`README.md`,`face-ai-report.md`)以匹配固定双通道输出行为.

## [1.0.73] - 2026-02-10

### English

#### Changed
- Added glob examples for `lm_findTextInFiles` `includePattern` usage in tool description to align with `lm_findFiles` guidance.
- Renamed internal find-tool constants from `COPILOT_FIND_*` to `LM_FIND_*` in `src/tooling.ts` for naming consistency, with no behavior change.

### 中文

#### 变更
- 在工具描述中为 `lm_findTextInFiles` 的 `includePattern` 增加 glob 示例,与 `lm_findFiles` 指引保持一致.
- 将 `src/tooling.ts` 内部 find 工具常量由 `COPILOT_FIND_*` 重命名为 `LM_FIND_*`,统一命名且不改变行为.

## [1.0.72] - 2026-02-10

### English

#### Changed
- Corrected release history in `CHANGELOG.md`: removed `Unreleased` aggregation, split entries into concrete release sections (`1.0.62` to `1.0.71`), and aligned ordering in descending versions.

### 中文

#### 变更
- 修正 `CHANGELOG.md` 版本历史: 移除 `Unreleased` 聚合段,将变更拆分归档到实际版本(`1.0.62` 到 `1.0.71`),并按版本降序排列.

## [1.0.71] - 2026-02-10

### English

#### Changed
- Stabilized `discovery.bridgedTools` ordering: tools are now sorted by name in deterministic alphabetical order (case-insensitive, with original-name tiebreaker).

### 中文

#### 变更
- 稳定 `discovery.bridgedTools` 顺序: 现在按工具名做确定性字母排序(case-insensitive,同名折叠后按原始 name 作为次级比较).

## [1.0.70] - 2026-02-10

### English

#### Changed
- Standardized custom search/diagnostics output for `lm_findTextInFiles`, `lm_findFiles`, and `lm_getDiagnostics`: `structuredContent` is now always a JSON object, while `content.text` is a human-readable summary.
- Updated find summaries to remove `showing: x/y` truncation and use block-style entries (`---`, `// path:line`, preview on next line for text matches; full path list for file matches).
- Updated `lm_findFiles` summary path lines to output raw file paths (without `//` prefix) while keeping `---` separators.
- Fixed handshake discovery `tools/list` fetch format by using a valid internal JSON-RPC request id (instead of `id: null`), so `discovery.bridgedTools` can be populated when workspace tools are available.
- Updated `lmToolsBridge.requestWorkspaceMCPServer` tool-call text output to a human-readable multi-line summary while keeping `structuredContent` as the full JSON payload.
- Discovery diagnostics are now unified under `discovery.issues` with hierarchical entries (`level`, `category`, `code`, `message`, optional `toolName/details`) for both errors and warnings.
- Schema-read misses during discovery are now reported as `warning` issues (instead of silent degradation) while preserving non-blocking fallback behavior.
- Updated `requestWorkspaceMCPServer` human-readable text summary to include an indented bridged tool name list under `tools:` while keeping `structuredContent` unchanged.
- Marked `copilot_getErrors` and `copilot_readProjectStructure` as built-in disabled (never exposed/enabled).
- Handshake response now uses a compact discovery payload (`callTool`, `bridgedTools`, `resourceTemplates`, `partial`, `issues`) to reduce extra list calls after `lmToolsBridge.requestWorkspaceMCPServer`.
- `discovery.partial` is now driven by `error`-level issues only; `warning` issues do not mark discovery as partial.
- `discovery` no longer returns `resources`; it now returns handshake-level `resourceTemplates` for URI composition.
- Improved manager session resilience for handshake calls: when `Mcp-Session-Id` is missing or stale, `lmToolsBridge.requestWorkspaceMCPServer` now auto-recovers with a new session header instead of failing early with HTTP 400 transport errors.

### 中文

#### 变更
- 统一 `lm_findTextInFiles`,`lm_findFiles`,`lm_getDiagnostics` 的输出: `structuredContent` 固定为 JSON 对象,`content.text` 固定为人类可读摘要文本.
- 调整 find 摘要文本: 移除 `showing: x/y` 截断提示并改为分块格式(`---`,`// path:line`,预览另起一行),文件搜索改为输出完整路径列表.
- 调整 `lm_findFiles` 摘要路径行格式: 保留 `---` 分隔符,但路径行不再带 `//` 前缀.
- 修复握手 discovery 拉取 `tools/list` 的请求格式: 内部 JSON-RPC 请求改为有效 id(不再使用 `id: null`),在工作区工具可用时 `discovery.bridgedTools` 可正常填充.
- 调整 `lmToolsBridge.requestWorkspaceMCPServer` 的 tools/call 文本输出为人类可读多行摘要,同时保持 `structuredContent` 为完整 JSON 载荷.
- discovery 诊断统一为 `discovery.issues` 分层结构(`level`,`category`,`code`,`message`,可选 `toolName/details`),同时承载 error 与 warning.
- discovery 中 schema 读取失败改为显式 `warning` issue(不再静默),并保持非阻断回退.
- 调整 `requestWorkspaceMCPServer` 的人类可读摘要文本: 在 `tools:` 下新增缩进的 bridged tool 名称列表,同时保持 `structuredContent` 不变.
- 将 `copilot_getErrors` 与 `copilot_readProjectStructure` 设为 built-in disabled(永不暴露/启用).
- 握手响应 discovery 改为精简结构(`callTool`,`bridgedTools`,`resourceTemplates`,`partial`,`issues`),减少 `lmToolsBridge.requestWorkspaceMCPServer` 之后的额外 list 调用.
- `discovery.partial` 现在仅由 `error` 级 issue 决定; `warning` 不会触发 partial.
- `discovery` 不再返回 `resources`; 现在返回握手级 `resourceTemplates` 用于 URI 拼装.
- 提升握手场景的会话健壮性: 当 `Mcp-Session-Id` 缺失或过期时,`lmToolsBridge.requestWorkspaceMCPServer` 现在会自动恢复新会话并返回新 session header,避免早期 HTTP 400 传输错误.

## [1.0.69] - 2026-02-10

### English

#### Changed
- Breaking change: handshake response switched to compact discovery payload (`callTool`, `bridgedTools`, `partial`, `errors`) to reduce post-handshake discovery overhead.
- `discovery.callTool` is a dedicated manager bridge descriptor with inline `inputSchema`; `lmToolsBridge.requestWorkspaceMCPServer` is excluded from discovery tool items.
- `discovery.bridgedTools[].description` appends a simple `Input: { ... }` hint when tool schema metadata is available.
- Breaking change: `discovery` no longer returns `resources` or `resourceTemplates`; clients should use standard MCP list/read APIs when resource discovery is needed.

### 中文

#### 变更
- Breaking change: 握手响应 discovery 改为精简结构(`callTool`,`bridgedTools`,`partial`,`errors`),减少握手后的发现开销.
- `discovery.callTool` 作为独立 manager 桥接工具返回并内联 `inputSchema`; `lmToolsBridge.requestWorkspaceMCPServer` 不再出现在 discovery 工具项中.
- `discovery.bridgedTools[].description` 在可用 schema 元数据时会追加简化 `Input: { ... }` 提示.
- Breaking change: `discovery` 不再返回 `resources` 与 `resourceTemplates`; 如需资源发现请使用标准 MCP list/read API.

## [1.0.68] - 2026-02-10

### English

#### Changed
- Breaking change: renamed custom diagnostics tool from `lm_getErrors` to `lm_getDiagnostics`.
- No compatibility alias is provided; callers and local settings must migrate to `lm_getDiagnostics` manually.
- Kept tool behavior and payload schema unchanged (`filePath`/`severities`/`maxResults` input and diagnostics summary + structured payload output).
- Updated defaults for clangd tools: they are exposed by default but not enabled by default.

### 中文

#### 变更
- Breaking change: 自定义诊断工具由 `lm_getErrors` 更名为 `lm_getDiagnostics`.
- 不提供兼容 alias; 外部调用和本地配置需手动迁移到 `lm_getDiagnostics`.
- 保持工具行为和输出结构不变(输入仍为 `filePath`/`severities`/`maxResults`,输出仍为诊断摘要与结构化载荷).
- 调整 clangd 工具默认策略: 默认暴露,但不默认启用.

## [1.0.66] - 2026-02-09

### English

#### Changed
- Added a new custom diagnostics tool `lm_getErrors` backed by `vscode.languages.getDiagnostics`, with stable structured output (`source/scope/severities/capped/totalDiagnostics/files`), optional `filePath` filter, severity/maxResults controls, no `uri` field in file entries, and per-diagnostic source preview (`startLine..endLine`, capped at 10 lines with availability/truncation flags).
- Enforced `lmToolsBridge.useWorkspaceSettings` as workspace-only at runtime by auto-removing User-scope values and showing a warning.
- Added `Open Settings` action to the status menu for direct navigation to extension settings.

### 中文

#### 变更
- 新增自定义诊断工具 `lm_getErrors`,基于 `vscode.languages.getDiagnostics` 输出稳定结构化结果(`source/scope/severities/capped/totalDiagnostics/files`),并支持 `filePath` 过滤与 severity/maxResults 控制; 文件项不再包含 `uri`,且每条诊断附带 `startLine..endLine` 代码预览(最多 10 行,带可用性/截断标记).
- 在运行时将 `lmToolsBridge.useWorkspaceSettings` 强制为仅工作区级: 若出现在 User 级会自动移除并提示.
- 在状态菜单新增 `Open Settings` 操作,可直接跳转到扩展设置页.

## [1.0.65] - 2026-02-09

### English

#### Changed
- Refined LM forwarding mapping: `content.text` now only forwards `LanguageModelTextPart`, and JSON `LanguageModelDataPart` mime detection now accepts `application/json; charset=...` and `*+json` variants for `structuredContent`.

### 中文

#### 变更
- 细化 LM tool 转发映射: `content.text` 仅透传 `LanguageModelTextPart`,并增强 `LanguageModelDataPart` 的 JSON mime 识别(`application/json; charset=...` 与 `*+json` 变体)以稳定透传 `structuredContent`.

## [1.0.64] - 2026-02-08

### English

#### Changed
- Updated LM tool forwarding output mapping: `LanguageModelDataPart` JSON object is now passed through as `structuredContent`, while `LanguageModelTextPart` is used for `content.text` to avoid duplicate wrapping.

### 中文

#### 变更
- 调整 LM tool 转发输出映射: `LanguageModelDataPart` 的 JSON object 直通 `structuredContent`,`LanguageModelTextPart` 仅作为 `content.text`,避免重复包装.

## [1.0.63] - 2026-02-08

### English

#### Changed
- Unified clangd structured location fields to `absolutePath` (always) + `workspacePath` (nullable), with 1-based numeric coordinates and optional `preview`.
- Removed legacy structured path fields (`summaryPath`, `location.path#...`) and dropped raw input echo fields from AI-first structured payloads.
- Updated `lm_clangd_symbolInfo` to classify symbol category via document symbols and emit adaptive entries; `typeDefinition` is now included only when meaningful (for example value-like symbols).
- Disabled `lm_clangd_ast` exposure and removed it from default exposed/enabled clangd tool list.
- Updated `lm_clangd_status` and `lm_clangd_lspRequest` to return human-readable text content while preserving structured JSON objects in `structuredContent`.

### 中文

#### 变更
- 统一 clangd 结构化位置字段为 `absolutePath`(必有) + `workspacePath`(可空),并使用 1-based 数值坐标与可选 `preview`.
- 移除旧结构化路径字段(`summaryPath`,`location.path#...`),并清理 AI-first 结构化载荷中的输入回显字段.
- 更新 `lm_clangd_symbolInfo`: 基于 document symbols 做符号类别判定并自适应输出条目; `typeDefinition` 仅在有意义场景(如 value-like 符号)返回.
- 禁用 `lm_clangd_ast` 暴露并将其从 clangd 默认 exposed/enabled 列表移除.
- 将 `lm_clangd_status` 与 `lm_clangd_lspRequest` 的 `content` 调整为人类可读文本,同时保留 `structuredContent` 结构化对象.

## [1.0.62] - 2026-02-08

### English

#### Changed
- Breaking change: clangd AI-first tools now use `filePath` input instead of `uri`.
- Added workspace-aware path parsing for `filePath`: `WorkspaceName/...` and absolute paths are accepted, `file:///...` is rejected.
- Switched `lm_clangd_typeHierarchy` output to AI summary text (`counts + --- + sections + entries`) and removed file coordinate JSON payload fields.
- Added AI-first symbol tools: `lm_clangd_symbolSearch`, `lm_clangd_symbolInfo`, `lm_clangd_symbolReferences`, `lm_clangd_symbolImplementations`, and `lm_clangd_callHierarchy`.
- Added `lm_clangd_symbolBundle` to aggregate symbol search/info/references/implementations/call-hierarchy into one AI-first call.
- Added `structuredContent` for clangd AI-first tools so clients can use stable machine-readable payloads alongside summary text.
- Enhanced `lm_clangd_symbolSearch` to include full symbol signatures by default, using fallback chain `signatureHelp -> hover -> definitionLine`.
- Updated `lm_clangd_symbolInfo` snippet sourcing to exclude generated files (`*.generated.h`, `*.gen.cpp`) and no longer fallback to generated locations.
- Updated `lm_clangd_typeHierarchy` SOURCE text order to `type -> preview -> path`, and added `preview` to `structuredContent.sourceByClass`.
- Updated `lm_clangd_typeHierarchy` source range strategy to rely on `textDocument/documentSymbol` only; when no matching symbol is found, output now falls back to single-line range (`endLine = startLine`).
- Updated `lm_clangd_typeHierarchy` to return a compact summary payload (`root`, `supers`, `derivedByParent`, `sourceByClass`, `limits`, `truncated`) with bounded expansion controls.
- Replaced `lm_clangd_typeHierarchy` input options `resolve/direction` with `maxSuperDepth`, `maxSubDepth`, and `maxSubBreadth`.
- Improved `sourceByClass.startLine` for Unreal C++ types: when the previous line is `UCLASS(...)` or `USTRUCT(...)`, the macro line is reported as the start line.
- Removed `lm_clangd_typeHierarchyResolve` from exposed clangd tools and dropped its dedicated implementation entrypoint.

### 中文

#### 变更
- Breaking change: clangd AI-first 工具输入从 `uri` 改为 `filePath`.
- 新增工作区感知 `filePath` 解析: 接受 `WorkspaceName/...` 和绝对路径,拒绝 `file:///...`.
- `lm_clangd_typeHierarchy` 输出切换为 AI 摘要文本(`counts + --- + sections + entries`),不再返回文件坐标 JSON 字段.
- 新增 AI-first 符号工具: `lm_clangd_symbolSearch`,`lm_clangd_symbolInfo`,`lm_clangd_symbolReferences`,`lm_clangd_symbolImplementations`,`lm_clangd_callHierarchy`.
- 新增 `lm_clangd_symbolBundle`,支持一次调用聚合 symbol search/info/references/implementations/call hierarchy.
- 为 clangd AI-first 工具补充 `structuredContent`,可在摘要文本之外提供稳定可机读载荷.
- 增强 `lm_clangd_symbolSearch`,默认返回完整符号签名,并使用 `signatureHelp -> hover -> definitionLine` 回退链路.
- 调整 `lm_clangd_symbolInfo` snippet 选点规则: 默认排除 generated 文件(`*.generated.h`,`*.gen.cpp`),且不再回退到 generated 位置.
- 调整 `lm_clangd_typeHierarchy` 的 SOURCE 文本顺序为 `type -> preview -> path`,并在 `structuredContent.sourceByClass` 新增 `preview` 字段.
- 调整 `lm_clangd_typeHierarchy` 区间策略为仅依赖 `textDocument/documentSymbol`; 未命中匹配符号时回退为单行区间(`endLine = startLine`),不再使用本地大括号扫描.
- 更新 `lm_clangd_typeHierarchy` 输出为汇总结构(`root`,`supers`,`derivedByParent`,`sourceByClass`,`limits`,`truncated`),并支持有界展开.
- 将 `lm_clangd_typeHierarchy` 入参从 `resolve/direction` 调整为 `maxSuperDepth`,`maxSubDepth`,`maxSubBreadth`.
- 优化 Unreal C++ 类型的 `sourceByClass.startLine`: 当前一行是 `UCLASS(...)` 或 `USTRUCT(...)` 宏时,起始行会上移到宏所在行.
- 移除 `lm_clangd_typeHierarchyResolve` 的 clangd 工具暴露及其独立实现入口.

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
