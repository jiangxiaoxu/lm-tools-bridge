# Changelog

All notable changes to this project are documented in this file.

Maintenance rule:
- For each release, keep both `### English` and `### 中文` sections.
- Keep section order aligned to reduce translation drift.

## [1.0.146] - 2026-04-07

### English

#### Changed
- Refined the `pathScope` example wording to use a more abstract placeholder workspace name while keeping `UE5` examples where helpful, reducing the chance that users mistake documentation examples for real bound workspace prefixes.

### 中文

#### Changed
- 优化 `pathScope` 示例文案,将容易被误解为真实业务 workspace 的名称改为更抽象的占位符,同时保留必要的 `UE5` 示例,降低把文档示例误当作实际绑定前缀的风险.

## [1.0.145] - 2026-04-07

### English

#### Changed
- Expanded the `lmToolsBridge.bindWorkspace` trigger wording to explicitly recognize requests that say `vscode-tools` or `use vscode` while preserving the existing vscode-tools-like auto-start behavior.
- Synced README and AI preload guidance with the new trigger keywords.

### 中文

#### Changed
- 扩展 `lmToolsBridge.bindWorkspace` 的 trigger wording,显式识别包含 `vscode-tools` 或 `use vscode` 的请求,同时保留原有类似 vscode-tools 的自启动行为.
- 同步 README 与 AI preload guidance,使其与新的 trigger keywords 保持一致.

## [1.0.144] - 2026-04-07

### English

#### Changed
- Added an explicit trigger hint to `lmToolsBridge.bindWorkspace` so agents can recognize vscode-tools-like workspace search, code navigation, diagnostics, and VS Code IDE tasks as bridge-entry work.
- Synced tests and docs with the new `bindWorkspace` entrypoint wording.

### 中文

#### Changed
- 为 `lmToolsBridge.bindWorkspace` 增加显式 trigger hint,让 agent 能将类似 vscode-tools 的 workspace search、code navigation、diagnostics 与 VS Code IDE tasks 识别为 bridge 入口任务.
- 同步更新测试和文档,使其与新的 `bindWorkspace` 入口文案保持一致.

## [1.0.143] - 2026-04-07

### English

#### Changed
- Polished the bridge public surface around `lmToolsBridge.bindWorkspace`, `lmToolsBridge.callBridgedTool`, `lm-tools-bridge://guide`, and `lm-tools://tool-names` so names and descriptions follow one delayed-loading contract.
- Tightened tool descriptions to keep medium-detail first-use constraints, while keeping detailed workflow, routing, fallback, and `pathScope` guidance inside `lm-tools-bridge://guide` and related resources.

#### Removed
- Removed the deprecated packaged `skills/vscode-tools` bundle because the runtime tool and resource descriptions now carry the bridge usage guidance directly.

### 中文

#### Changed
- 围绕 `lmToolsBridge.bindWorkspace`、`lmToolsBridge.callBridgedTool`、`lm-tools-bridge://guide` 和 `lm-tools://tool-names` 统一收口 bridge public surface,使名称与描述遵循同一套 delayed-loading contract.
- 收紧工具描述,仅保留中等粒度的首用约束; 更详细的 workflow、routing、fallback 与 `pathScope` 指南统一留在 `lm-tools-bridge://guide` 及相关 resource 中.

#### Removed
- 删除已弃用的打包 `skills/vscode-tools` bundle,因为 bridge 使用指引现在已经直接由运行时 tool 与 resource 描述承载.

## [1.0.142] - 2026-03-28

### English

#### Changed
- Reduced handshake `discovery.bridgedTools` entries to tool names only, so clients always fetch descriptions and schemas from `lm-tools://tool/{name}` on demand.
- Kept `discovery.callTool` descriptive metadata in the handshake payload and updated docs/tests to match the leaner discovery contract.

### 中文

#### Changed
- 将握手 `discovery.bridgedTools` 条目收敛为仅返回 tool name, 促使客户端按需从 `lm-tools://tool/{name}` 读取 description 和 schema.
- 保留握手 `discovery.callTool` 的描述性元数据, 并同步更新文档和测试以匹配更精简的 discovery contract.

## [1.0.141] - 2026-03-28

### English

#### Changed
- Removed `toolUri` and `usageHint` from `lm-tools://tool/{name}` payloads on both direct workspace-server and stdio-manager paths.
- Simplified tool-definition text output and tests so `name`, `description`, `tags`, and `inputSchema` remain the canonical fields.

### 中文

#### Changed
- 删除直连 workspace server 和 stdio manager 路径下 `lm-tools://tool/{name}` payload 中的 `toolUri` 和 `usageHint`.
- 精简 tool definition 文本输出和测试,将 `name`,`description`,`tags`,`inputSchema` 保持为 canonical fields.

## [1.0.140] - 2026-03-28

### English

#### Changed
- Removed `lm-tools://schema/{name}` and made `lm-tools://tool/{name}` the only resource for bridged tool definitions and `inputSchema`.
- Removed `schemaUri` from tool metadata and updated handshake guidance, docs, and skills to read tool definitions before the first bridged call.

### 中文

#### Changed
- 删除 `lm-tools://schema/{name}`,将 `lm-tools://tool/{name}` 收敛为桥接 tool definition 和 `inputSchema` 的唯一 resource.
- 移除 tool metadata 里的 `schemaUri`,并同步更新 handshake guidance、文档与 skill 指引,统一为首次桥接调用前读取 tool definition.

## [1.0.139] - 2026-03-25

### English

#### Changed
- Bumped the extension version for the next release cut with no additional functional changes.

### 中文

#### Changed
- 提升扩展版本号,用于下一次发布切分,无额外功能变更.

## [1.0.138] - 2026-03-25

### English

#### Changed
- Normalized VS Code-sourced tool names to `lm_*`, kept runtime invocation on original source names, and auto-migrated exact-name tool config entries.

### 中文

#### Changed
- 将来自 VS Code 的工具名统一规范为 `lm_*`, 保持运行时仍调用原始 source tool name, 并自动迁移精确工具名配置项.

## [1.0.137] - 2026-03-22

### English

#### Changed
- Bumped patch version to 1.0.137.

### 中文

#### Changed
- 将 patch 版本提升到 1.0.137。

## [1.0.136] - 2026-03-20

### English

#### Changed
- Bumped patch version to 1.0.136.
- Compressed the shared `lm-tools://spec/pathScope` guidance while keeping the mixed scoped and unscoped brace example explicit.
- Clarified that the shared syntax resource applies only to `pathScope` fields and not to file-search `query` fields, and aligned the README notes with the shorter wording.

### 中文

#### Changed
- 将 patch 版本提升到 1.0.136。
- 在保留 scoped 与 unscoped mixed brace 示例的前提下,进一步压缩了共享 `lm-tools://spec/pathScope` 文案。
- 明确共享语法资源仅适用于 `pathScope` 字段,不适用于 file-search `query` 字段,并同步收敛 README 说明。

## [1.0.135] - 2026-03-20

### English

#### Changed
- Bumped patch version to 1.0.135.
- Breaking change: renamed the shared path filter input from `includePattern` to `pathScope` across `lm_findTextInFiles`, `lm_qgrepSearchText`, and `lm_getDiagnostics`.
- Renamed the shared syntax resource to `lm-tools://spec/pathScope` and updated schema metadata, resource registration, and handshake guidance to point to the new contract.
- Rewrote the shared `pathScope` spec and README notes around accepted forms, important rules, common examples, and invalid or misleading examples using `GameWorkspace` and `UE5`.

### 中文

#### Changed
- 将 patch 版本提升到 1.0.135.
- Breaking change: 将 `lm_findTextInFiles`、`lm_qgrepSearchText` 和 `lm_getDiagnostics` 共享的路径过滤输入从 `includePattern` 重命名为 `pathScope`.
- 将共享语法资源重命名为 `lm-tools://spec/pathScope`,并同步更新 schema metadata、resource 注册和 handshake guidance 指向新的契约.
- 重写共享 `pathScope` spec 与 README 说明,补充 accepted forms、important rules、common examples 以及 invalid or misleading examples,并统一使用 `GameWorkspace` 和 `UE5` 示例.

## [1.0.134] - 2026-03-20

### English

#### Changed
- Bumped patch version to 1.0.134.
- Added the shared `lm-tools://spec/includePattern` resource and shared schema metadata so tools using `includePattern` point to one syntax contract.
- `lm_findTextInFiles.includePattern` now aligns with the shared contract, including brace-scoped workspace selectors, mixed scoped and unscoped top-level brace branches, and absolute paths or globs limited to current workspaces.
- Handshake guidance now requires clients to read `lm-tools://spec/includePattern` before using any argument named `includePattern`.

### 中文

#### Changed
- 补丁版本提升到 1.0.134.
- 新增共享资源 `lm-tools://spec/includePattern` 以及共享 schema metadata, 让使用 `includePattern` 的工具统一指向同一份语法契约.
- `lm_findTextInFiles.includePattern` 现已与共享契约对齐, 支持带 workspace 作用域的 brace selector, 混合 scoped/unscoped 的顶层 brace 分支, 以及限制在当前 workspace 内的 absolute path 或 glob.
- handshake guidance 现在要求 client 在使用任何名为 `includePattern` 的参数前先读取 `lm-tools://spec/includePattern`.

## [1.0.133] - 2026-03-20

### English

#### Changed
- Bumped patch version to 1.0.133.
- Breaking change: `lm_getDiagnostics` replaced `filePaths` with `includePattern`, and the new filter now uses the same workspace path/glob syntax as the search tools.
- `lm_getDiagnostics` filtered output now reports `scope=filtered`, echoes the active `includePattern`, excludes non-workspace diagnostics while filtered, and returns empty results instead of errors when a valid glob matches no files.
- Clarified `lm_getDiagnostics.includePattern` examples for recursive and multi-extension glob usage in tool metadata and README.

### 中文

#### 变更
- 将 patch 版本提升到 1.0.133。
- Breaking change: `lm_getDiagnostics` 将输入过滤参数从 `filePaths` 改为 `includePattern`,并改为复用搜索工具的 workspace path / glob 语法。
- `lm_getDiagnostics` 在过滤模式下现在会输出 `scope=filtered`,回显当前 `includePattern`,过滤掉不属于当前 workspace 的诊断,并在合法 glob 无匹配时返回空结果而不是报错。
- 在工具元数据和 README 中补充 `lm_getDiagnostics.includePattern` 的递归与多扩展 glob 示例说明。

## [1.0.132] - 2026-03-19

### English

#### Changed
- Bumped patch version to 1.0.132.
- Expanded the qgrep managed Unreal include set so indexed workspaces now include `*.uplugin` and `*.uproject` files alongside `*.ush`, `*.usf`, and `*.ini`.

### 中文

#### 变更
- 将 patch 版本提升到 1.0.132。
- 扩展 qgrep 自动维护的 Unreal include 集合,现在除了 `*.ush`,`*.usf`,`*.ini` 之外,还会索引 `*.uplugin` 和 `*.uproject` 文件。

## [1.0.131] - 2026-03-19

### English

#### Changed
- Bumped patch version to 1.0.131.
- Trimmed successful `lmToolsBridge.requestWorkspaceMCPServer` payloads to remove `mcpSessionId` and transport/session fields from `target`, keeping only workspace identity plus discovery/guidance data.
- Trimmed `lm-tools-bridge://handshake` status snapshots so exposed `target` data now contains only `workspaceFolders` and `workspaceFile`.

### 中文

#### 变更
- 将 patch 版本提升到 1.0.131。
- 精简成功的 `lmToolsBridge.requestWorkspaceMCPServer` payload,移除 `mcpSessionId` 以及 `target` 下的 transport/session 字段,仅保留 workspace 身份信息和 discovery/guidance 数据。
- 精简 `lm-tools-bridge://handshake` 的 status snapshot,对外暴露的 `target` 现仅包含 `workspaceFolders` 和 `workspaceFile`。

## [1.0.130] - 2026-03-19

### English

#### Changed
- Bumped patch version to 1.0.130.
- `lm_qgrepSearchText` now reports query rewrite details at runtime through `queryHint:` summary lines for whitespace-only pipe branch dropping and raw-literal fallback, while keeping tool descriptions and input schemas more concise.
- qgrep tool descriptions and input schemas were streamlined to reduce redundancy while preserving complete search and scope examples.

### 中文

#### 变更
- 版本补丁号提升至 1.0.130.
- `lm_qgrepSearchText` 现在会在运行时通过 `queryHint:` 摘要行提示 query 重写细节,包括仅空白 pipe branch 的丢弃以及 raw literal fallback,同时保持工具描述和 input schema 更精简.
- qgrep 相关工具描述与 input schema 已进一步收敛,减少重复信息,同时保留完整的搜索与 scope 示例.

## [1.0.129] - 2026-03-19

### English

#### Changed
- Bumped patch version to 1.0.129.
- `lm_qgrepSearchText` now defaults to literal-or-regex text semantics: top-level `|` means literal OR, only whole outer double-quoted branches keep `|` literal, malformed quotes are treated as ordinary characters, and empty split branches fall back to matching the raw query literally.
- `beforeContextLines` and `afterContextLines` now clamp at `50` instead of failing when oversized, and qgrep text summaries report the originally requested context values when truncation happens.

### 中文

#### 变更
- 版本补丁号提升至 1.0.129.
- `lm_qgrepSearchText` 现在固定使用 literal 或 regex 文本语义: 顶层 `|` 表示 literal OR,只有最外层完整双引号包裹的 branch 才会保留字面量 `|`,不完整引号按普通字符处理,空 branch 会回退为按原始 query 做 literal 匹配.
- `beforeContextLines` 和 `afterContextLines` 的超限输入现在会钳制到 `50`,不再直接报错,并且 qgrep 文本摘要会显示被截断前的原始请求值.

## [1.0.128] - 2026-03-18

### English

#### Changed
- Bumped patch version to 1.0.128.
- `lm_qgrepSearchText` now auto-normalizes simple top-level `A|B|C` glob mistakes to brace globs with `warning` and `effectiveQuery` in text output, while more complex non-top-level `|` usage now fails fast with guidance.

### 中文

#### 变更
- 版本补丁号提升至 1.0.128.
- `lm_qgrepSearchText` 现在会将简单顶层 `A|B|C` glob 误用自动规范化为 brace glob,并在文本输出中提示 `warning` 与 `effectiveQuery`; 更复杂的非顶层 `|` 用法现在会直接 fail-fast,并提示改用 brace glob 或 `querySyntax='regex'`.

## [1.0.127] - 2026-03-16

### English

#### Changed
- Bumped patch version to 1.0.127.

### 中文

#### 变更
- 版本补丁号提升至 1.0.127.

## [1.0.126] - 2026-03-16

### English

#### Changed
- Bumped patch version to 1.0.127.

### 中文

#### 变更
- 版本补丁号提升至 1.0.127.

### English

#### Changed
- qgrep brace-glob scope parsing now supports mixed top-level alternation that combines `WorkspaceName/...` branches with workspace-relative branches. Unscoped branches apply to all current workspaces, scoped branches stay limited to their selected workspaces, and overlapping per-workspace branches are merged before execution to avoid duplicate file or text hits.

### 中文

#### 变更
- qgrep 的 brace glob scope 解析现已支持在顶层 alternation 中混用 `WorkspaceName/...` 分支和普通 workspace-relative 分支. 不带 workspace 前缀的分支会作用于所有当前 workspace, 带前缀的分支只作用于指定 workspace, 同一 workspace 上重叠的分支会在执行前合并, 避免 file search 或 text search 出现重复命中.

## [1.0.125] - 2026-03-16

### English

#### Changed
- MCP transport now switches to stdio mode in the bridged runtime path. Update MCP clients from HTTP endpoints to stdio manager wiring to continue receiving tool calls; see `README.md` section `Codex MCP Config` for the new setup steps.

### 中文

#### 变更
- MCP 已改为 stdio 运行模式, 运行时请将外部 MCP 客户端从 HTTP 方式切换到 stdio 模式, 否则将无法继续正常调用工具. 迁移前请先查看 `README.md` 中的 `### Codex MCP 配置` 节, 按文档完成连接配置.

## [1.0.124] - 2026-03-14

### English

#### Changed
- Trimmed `lmToolsBridge.requestWorkspaceMCPServer.discovery.bridgedTools` to summary fields only, so handshake payloads no longer include each bridged tool's `inputSchema`.
- Changed the stdio manager to resolve bridged tool schemas on demand through `lm-tools://schema/{name}` or `lm-tools://tool/{name}` resources instead of fan-out schema reads during handshake.

#### Tests
- Updated handshake and stdio manager unit coverage to assert summary-only `bridgedTools` discovery while preserving schema resource reads after handshake.

### 中文

#### Changed
- 精简 `lmToolsBridge.requestWorkspaceMCPServer.discovery.bridgedTools`, 握手返回现在只保留工具摘要字段, 不再携带每个 bridged tool 的 `inputSchema`.
- 调整 stdio manager 的 schema 获取方式, 改为通过 `lm-tools://schema/{name}` 或 `lm-tools://tool/{name}` 按需读取, 不再在握手阶段对所有工具做 fan-out schema 读取.

#### Tests
- 更新握手和 stdio manager 单元测试, 验证 `bridgedTools` discovery 为摘要模式, 同时保留握手后的 schema 资源读取能力.

## [1.0.123] - 2026-03-14

### English

#### Added
- Added a Windows startup-time Node.js runtime check so the extension warns when external `node` is unavailable on `PATH` before the synced stdio manager is needed.

#### Changed
- Added `Install with winget` and `Download Node.js` recovery actions to the startup warning, and kept failure handling self-contained so activation does not leak async errors.
- Changed the workspace MCP server to always auto-start on extension activation, removing the public `server.autoStart` toggle and manual start/stop server commands.

#### Tests
- Added unit coverage for the startup dependency prompt and kept the verification path on injected doubles so automated tests do not launch real installers or browsers.

### 中文

#### 新增
- 在 Windows 上新增启动期 Node.js 运行时检查,当系统 `PATH` 上缺少外部 `node` 时,会在同步 stdio manager 真正使用前先给出提示。

#### 变更
- 启动提示新增 `Install with winget` 与 `Download Node.js` 恢复入口,并将相关失败处理收敛为自包含日志路径,避免扩展激活泄漏异步错误。
- workspace MCP server 改为扩展激活后总是自动启动,并移除了公开的 `server.autoStart` 开关以及手动 start/stop server 命令。

#### 测试
- 为启动期依赖提示新增单元测试覆盖,并统一使用注入 double 验证分支,确保自动化测试不会真实拉起安装器或浏览器。

## [1.0.122] - 2026-03-14

### English

#### Changed
- Added activation-time publication of the bundled stdio manager into `%LOCALAPPDATA%\lm-tools-bridge`, making a stable runnable `stdioManager.js` available for external MCP clients.
- Changed stdio manager publication overwrite decisions to compare the actual source and target file hashes, while keeping `metadata.json` for version and sync diagnostics only.

#### Tests
- Added unit and smoke/integration coverage for `%LOCALAPPDATA%` publication, runnable synced manager validation, metadata repair, and direct file-hash sync decisions.

### 中文

#### Changed
- 新增扩展激活时自动把 bundled stdio manager 发布到 `%LOCALAPPDATA%\lm-tools-bridge`,为外部 MCP 客户端提供稳定可运行的 `stdioManager.js`.
- stdio manager 发布时的覆盖判定改为直接比较源/目标文件 hash,`metadata.json` 仅保留版本与同步诊断信息.

#### Tests
- 新增 `%LOCALAPPDATA%` 发布、同步后 manager 可运行性、metadata 修复以及基于实际文件 hash 判定同步的单测与集成覆盖.

## [1.0.121] - 2026-03-14

### English

#### Changed
- Replaced the stdio manager workspace-instance registry with deterministic Windows named-pipe discovery, keeping folder and `.code-workspace` identities separate and removing the old file-backed heartbeat path.
- Kept stdio manager handshake auto-start scoped to handshake only while preserving multi-manager workspace routing and post-handshake offline behavior.

#### Tests
- Added discovery and stdio-manager coverage for named-pipe ownership, launch-lock behavior, handshake routing, and Windows real-VS-Code manager integration over MCP stdio.

### 中文

#### Changed
- 将 stdio manager 的 workspace 实例发现从文件 registry 切换为确定性的 Windows named pipe discovery,并保持 folder 与 `.code-workspace` 身份严格区分,移除了旧的文件心跳路径.
- 保持 stdio manager 的握手自启动行为只发生在 handshake 阶段,同时保留多 manager 路由到同一或不同 workspace 的能力,以及握手后实例离线时不自动重启的行为.

#### Tests
- 新增 named pipe owner/launch lock、stdio manager 握手路由,以及基于 MCP stdio 的 Windows 真实 VS Code manager integration 覆盖.

## [1.0.120] - 2026-03-14

### English

#### Fixed
- Fixed qgrep startup refresh so `workspace.cfg` also rewrites its `path <workspace-root>` line, preventing moved workspaces from watching or updating an old directory.

#### Tests
- Added unit coverage for stale qgrep workspace root path replacement and duplicate path-line cleanup.

### 中文

#### Fixed
- 修复 qgrep 启动刷新,现在会同时改写 `workspace.cfg` 中的 `path <workspace-root>` 首行,避免 workspace 搬迁后仍监听或更新旧目录.

#### Tests
- 新增单测,覆盖 qgrep 旧 workspace 根路径替换以及重复 path 行清理.

## [1.0.119] - 2026-03-14

### English

#### Changed
- Published a patch release for the stdio manager migration and Windows auto-start integration without additional behavior changes.

### 中文

#### Changed
- 发布一个 patch 版本,用于承载 stdio manager 迁移与 Windows 自动拉起集成,不引入额外行为变更。

## [1.0.118] - 2026-03-14

### English

#### Added
- Added a Windows-only `test:manager-integration` suite that launches `out/stdioManager.js` over stdio, auto-starts a real VS Code workspace instance during handshake, and verifies qgrep calls through the MCP bridge.

#### Changed
- Replaced the HTTP manager mainline with the stdio manager + shared instance registry flow for workspace binding and Windows handshake-time auto-start.
- Restored downstream workspace MCP compatibility for `text/event-stream` responses inside the stdio manager request path.
- Shared VS Code integration launch helpers between the existing extension-host suites and the new stdio manager integration suite.
- Simplified successful handshake payloads by omitting redundant top-level `online` and `health` fields while keeping actionable guidance in the stdio manager flow.

### 中文

#### Added
- 新增仅限 Windows 的 `test:manager-integration` 测试套件,通过 stdio 启动 `out/stdioManager.js`,在握手阶段自动拉起真实 VS Code workspace 实例,并通过 MCP bridge 验证 qgrep 调用。

#### Changed
- 用 stdio manager + 共享实例 registry 主流程替换了原来的 HTTP manager workspace 绑定路径,并支持 Windows 上仅在握手阶段自动拉起实例。
- 在 stdio manager 的下游 workspace MCP 请求路径中补回了对 `text/event-stream` 响应的兼容。
- 抽取并复用了 VS Code integration 启动 helper,供现有 extension-host 套件和新的 stdio manager 集成测试共用。
- 精简成功握手返回,移除冗余的顶层 `online` 和 `health` 字段,同时保留 stdio manager 流程中的可执行 guidance。

## [1.0.117] - 2026-03-12

### English

#### Changed
- Simplified `lmToolsBridge.requestWorkspaceMCPServer` success payload by removing redundant top-level `online` and `health` fields while keeping `target`, `discovery`, and `guidance` unchanged.
- Removed the `online:` line from the handshake text summary to match the trimmed JSON payload.

#### Tests
- Added unit coverage for handshake payload shaping and summary rendering.

### 中文

#### 变更
- 精简 `lmToolsBridge.requestWorkspaceMCPServer` 的成功返回,移除冗余的顶层 `online` 和 `health`,同时保持 `target`,`discovery`,`guidance` 结构不变.
- 调整握手文本摘要,移除 `online:` 行,与精简后的 JSON 返回保持一致.

#### 测试
- 新增握手 payload 与摘要渲染的单元测试覆盖.

## [1.0.116] - 2026-03-09

### English

#### Changed
- Published a follow-up patch release that keeps the `querySyntax` search contract and glob/path fail-fast validation from `1.0.115` without additional behavior changes.

### 中文

#### 变更
- 发布了一个跟进 patch 版本,沿用 `1.0.115` 中的 `querySyntax` 搜索 contract 与 glob/path fail-fast 校验,本次没有新增行为变化。

## [1.0.115] - 2026-03-09

### English

#### Changed
- Replaced the legacy `isRegexp` toggle with `querySyntax` across search tools so query syntax is explicit and scoped to the `query` field.
- Tightened glob/path validation to fail fast on bare `|` alternation in `includePattern`, `lm_findFiles.query`, and `lm_qgrepSearchFiles.query` when glob semantics apply, with guidance to use brace globs or regex mode where supported.

#### Tests
- Added unit and VS Code integration coverage for glob/path fail-fast validation and the new `querySyntax` contract.

### 中文

#### 变更
- 在搜索工具中用 `querySyntax` 替代旧的 `isRegexp`,让 `query` 的语法选择更明确,并且只作用于 `query` 字段本身。
- 收紧了 glob/path 输入校验: 对 `includePattern`,`lm_findFiles.query` 以及使用 glob 语义的 `lm_qgrepSearchFiles.query` 中的裸 `|` 直接 fail-fast,并提示改用 brace glob 或受支持的 regex 模式。

#### 测试
- 为 glob/path fail-fast 校验和新的 `querySyntax` contract 增加了 unit 与 VS Code integration 覆盖。

## [1.0.112] - 2026-03-08

### English

#### Docs
- Clarified `lm_qgrepSearchText` glob matching in tool descriptions and README as substring-based text matching without implicit `^...$` anchoring.
- Clarified `lm_qgrepSearchFiles` glob matching in tool descriptions and README as whole-path file matching rather than substring text matching.

### 中文

#### Docs
- 在工具描述和 README 中补充 `lm_qgrepSearchText` 的 glob 匹配说明, 明确其为 substring 形式的文本匹配, 不会隐式添加 `^...$` 锚定.
- 在工具描述和 README 中补充 `lm_qgrepSearchFiles` 的 glob 匹配说明, 明确其为整路径的文件匹配, 不是 substring 形式的文本匹配.

## [1.0.111] - 2026-03-06

### English

#### Tests
- Added VS Code integration test infrastructure with a repo-root smoke workspace and a temp-copied multi-root fixture runner on Windows.
- Expanded the multi-root fixture into an anonymized Unreal-style `Source` tree with scoped glob, deep `Private/**/*.cpp`, and cross-workspace target-glob coverage.

### 中文

#### Tests
- 新增 VS Code 集成测试基础设施, 在 Windows 上提供基于仓库根目录的 smoke workspace 和基于临时复制 multi-root fixture 的测试 runner。
- 扩充 multi-root fixture 为脱敏的 Unreal 风格 `Source` 目录, 覆盖 scoped glob, 深层 `Private/**/*.cpp` 和跨 workspace `Target` glob 聚合场景。

## [1.0.110] - 2026-03-06

### English

#### Fixed
- Updated `lm_qgrepSearchFiles` so `WorkspaceName/<glob>` is applied as workspace-relative path scoping in multi-root workspaces by anchoring non-absolute globs to the selected workspace root.
- Updated `lm_qgrepSearchFiles` to fail fast on invalid legacy params and malformed workspace-prefixed glob/regex queries before waiting for qgrep readiness.

#### Tests
- Added files-query draft parsing coverage for workspace-prefixed glob/regex queries and fail-fast validation.

### 中文

#### Fixed
- 更新 `lm_qgrepSearchFiles`, 使 `WorkspaceName/<glob>` 在 multi-root workspace 中按 workspace-relative path 生效, 并将非 absolute glob 绑定到选定 workspace root。
- 更新 `lm_qgrepSearchFiles`, 使其在等待 qgrep ready 之前就能对无效 legacy 参数和错误的 workspace 前缀 glob/regex 查询快速报错。

#### Tests
- 新增 files-query draft 解析测试, 覆盖 workspace 前缀 glob/regex 查询和 fail-fast 校验。

## [1.0.109] - 2026-03-06

### English

#### Fixed
- Updated `lm_qgrepSearchText` context rendering so extra true matches inside selected context windows are still marked as match lines (`:`) without expanding windows or changing result counts.

#### Tests
- Added qgrep context-rendering coverage for local line re-checking, window-boundary stability, and glob/regex matcher fallback behavior.

### 中文

#### 修复
- 调整 `lm_qgrepSearchText` 的上下文渲染, 让所选上下文窗口内的额外真实命中仍按命中行(`:`)显示, 同时不扩展窗口, 也不改变结果计数。

#### 测试
- 补充 qgrep 上下文渲染测试, 覆盖本地逐行复判、窗口边界稳定性, 以及 glob/regex matcher 的降级行为。

## [1.0.108] - 2026-03-05

### English

#### Changed
- Switched successful `lm_qgrepSearchText`, `lm_qgrepSearchFiles`, and `lm_qgrepGetStatus` responses to text-only output (`LanguageModelTextPart`) to reduce token overhead.
- Added `beforeContextLines`/`afterContextLines` to `lm_qgrepSearchText` (range `0-20`) and rendered merged multi-line preview blocks with fixed line-number prefixes.
- Standardized qgrep text/file output formatting to absolute `/` paths, `====` for file switches, and `---` for same-file context blocks.
- Updated qgrep tool descriptions and schemas to be more concise and input-focused, removing repetitive guidance lines.

### 中文

#### 变更
- 将 `lm_qgrepSearchText`、`lm_qgrepSearchFiles`、`lm_qgrepGetStatus` 的成功返回改为纯文本(`LanguageModelTextPart`),减少 token 开销。
- 为 `lm_qgrepSearchText` 增加 `beforeContextLines`/`afterContextLines` 参数(范围 `0-20`),并支持合并后的多行上下文预览与固定行号前缀输出。
- 统一 qgrep 文本/文件输出格式: 绝对 `/` 路径,文件切换分隔符为 `====`,同文件上下文区块分隔符为 `---`。
- 精简并收敛 qgrep 工具 description 与 schema 文案,改为更聚焦输入参数的信息表达。

## [1.0.107] - 2026-03-05

### English

#### Changed
- Unified qgrep glob parsing for `lm_qgrepSearchText` and `lm_qgrepSearchFiles` so both follow the same VS Code glob token semantics.
- `lm_qgrepSearchFiles` glob queries without `/` now match at any depth (for example, `*.md` behaves like `**/*.md`), aligning with `lm_findFiles`/ripgrep glob behavior.
- `lm_qgrepSearchText` glob mode now uses the same slash-aware token behavior (`*`/`?` do not cross `/`, `**` can cross `/`) while preserving substring matching.
- Added qgrep glob semantic tests and updated docs/tool descriptions to reflect the new behavior.

### 中文

#### 变更
- 统一 `lm_qgrepSearchText` 与 `lm_qgrepSearchFiles` 的 qgrep glob 解析,两者使用同一套 VS Code glob token 语义.
- `lm_qgrepSearchFiles` 在 glob 模式下,不含 `/` 的查询现在会匹配任意目录深度(例如 `*.md` 等价 `**/*.md`),与 `lm_findFiles`/ripgrep glob 行为对齐.
- `lm_qgrepSearchText` 在 glob 模式下改为同样的斜杠敏感 token 行为(`*`/`?` 不跨 `/`,`**` 可跨 `/`),并保持子串匹配.
- 新增 qgrep glob 语义测试,并同步更新文档与 tool 描述.

## [1.0.106] - 2026-03-05

### English

#### Changed
- `lm_qgrepSearchFiles` input is aligned to a `lm_findFiles`-like shape: `query`/`maxResults`, with optional `isRegexp` (default `false`).
- In default mode, `lm_qgrepSearchFiles.query` now follows VS Code glob semantics (`*`, `?`, `**`, `[]`, `[!...]`, `{a,b}`); `isRegexp=true` switches query parsing to regex.
- `lm_qgrepSearchFiles` now rejects legacy `mode` and `searchPath` inputs; `includeIgnoredFiles` is tolerated and ignored for compatibility.
- `lm_qgrepSearchFiles` payload now reports query semantics as `glob-vscode` or `regex`, and includes optional `scope` for scoped regex queries.
- Documentation and agent instructions now pin the same VS Code glob baseline for both `lm_qgrepSearchText.query` and `lm_qgrepSearchFiles.query`.

### 中文

#### 变更
- `lm_qgrepSearchFiles` 入参对齐到近似 `lm_findFiles` 形态: `query`/`maxResults`, 并新增可选 `isRegexp`(默认 `false`).
- 默认模式下, `lm_qgrepSearchFiles.query` 采用 VS Code glob 语义(`*`,`?`,`**`,`[]`,`[!...]`,`{a,b}`), 传 `isRegexp=true` 切换为 regex 解析.
- `lm_qgrepSearchFiles` 现在会拒绝旧 `mode` 和 `searchPath` 入参; 传 `includeIgnoredFiles` 时仅做兼容并静默忽略.
- `lm_qgrepSearchFiles` payload 的查询语义标记更新为 `glob-vscode` 或 `regex`, 并在作用域查询时返回可选 `scope`.
- 文档与指令文件同步固化 glob 基线: `lm_qgrepSearchText.query` 与 `lm_qgrepSearchFiles.query` 均以 VS Code glob 语义为准.

## [1.0.105] - 2026-03-04

### English

#### Added
- Handshake responses now include actionable `guidance` fields (`nextSteps` and `recoveryOnError`) to standardize schema-read, discovery-refresh, and rebind-retry flows.

#### Changed
- Manager JSON-RPC and direct-call validation errors now provide consistent `Next step:` recovery hints for missing/unknown session, workspace mismatch, offline MCP, invalid params, and retry guidance.
- Handshake and direct-call metadata descriptions were centralized to reduce drift across tool/resource/template payloads.

### 中文

#### 新增
- Handshake 返回新增可执行 `guidance` 字段(`nextSteps` 与 `recoveryOnError`),统一 schema read,discovery refresh,rebind retry 流程指引。

#### 变更
- Manager 的 JSON-RPC 与 direct-call 参数校验错误统一补充 `Next step:` 恢复提示,覆盖 missing/unknown session,workspace mismatch,offline MCP,invalid params 与重试路径。
- Handshake 与 direct-call 的元数据描述改为集中复用,减少 tool/resource/template 文案漂移。

## [1.0.104] - 2026-03-04

### English

#### Added
- Added startup qgrep auto-repair: when startup refresh `update` fails with a corruption-like assertion signature (`Assertion failed` and `filter.cpp`/`entries.entries`), the extension triggers one rebuild attempt per workspace per startup session.

#### Changed
- qgrep startup refresh now tracks one-shot per-workspace repair state and emits `qgrep.startup-repair:<workspace>` logs (`trigger`/`success`/`fail`/`skip`).

### 中文

#### 新增
- 新增 qgrep 启动期自动修复: 当启动刷新 `update` 出现坏索引特征断言(`Assertion failed` 且包含 `filter.cpp`/`entries.entries`)时,扩展会在本次启动周期内按 workspace 自动尝试一次重建。

#### 变更
- qgrep 启动刷新新增按 workspace 的一次性修复状态跟踪,并输出 `qgrep.startup-repair:<workspace>` 日志(`trigger`/`success`/`fail`/`skip`)。

## [1.0.103] - 2026-03-03

### English

#### Changed
- Refactored Windows workspace path handling into `src/windowsWorkspacePath.ts` and reused it from manager handshake/matching flows.

#### Fixed
- Handshake path validation now accepts both normal absolute Windows paths and `\\?\`-prefixed normal paths with case-insensitive prefix matching.
- Normal and `\\?\`-prefixed drive/UNC paths now normalize to equivalent comparable paths for stable workspace matching.

#### Added
- Added automated tests for Windows path handling, including drive paths (`G:\...` and `\\?\G:\...`) and UNC paths (`\\server\share\...` and `\\?\UNC\server\share\...`).

### 中文

#### 变更
- 将 Windows workspace 路径处理重构到 `src/windowsWorkspacePath.ts`,并在 manager 握手/匹配流程复用.

#### 修复
- 握手路径校验现在支持普通 Windows 绝对路径与 `\\?\` 前缀普通路径,且前缀匹配不区分大小写.
- 普通路径与 `\\?\` 前缀的 drive/UNC 路径会归一化为等价可比路径,提升 workspace 匹配稳定性.

#### 新增
- 新增 Windows 路径自动化测试,覆盖 drive 路径(`G:\...` 和 `\\?\G:\...`)以及 UNC 路径(`\\server\share\...` 和 `\\?\UNC\server\share\...`).

## [1.0.102] - 2026-03-02

### English

#### Fixed
- Added unified sanitization for custom tool `content.text` output to strip ANSI/control/bidi/zero-width characters for stable summary rendering.
- Kept `structuredContent` unchanged while applying display-layer sanitization only to text output.

### 中文

#### 修复
- 为 custom tool 的 `content.text` 增加统一清洗,去除 ANSI/control/bidi/zero-width 字符,提升 summary 渲染稳定性.
- 仅对文本展示层做清洗,`structuredContent` 保持不变.

## [1.0.101] - 2026-03-02

### English

#### Fixed
- Fixed qgrep text match parsing to split `path:line:preview` at the first `:line:` delimiter, preventing preview corruption when preview text contains `:number:` or similar colon segments.

### 中文

#### 修复
- 修复 qgrep 文本匹配解析: 现在按首个 `:line:` 分隔 `path:line:preview`,避免 preview 文本包含 `:number:` 等冒号片段时发生错位和污染.

## [1.0.100] - 2026-02-27

### English

#### Changed
- Simplified README structure and reduced duplicated long-form guidance while keeping current behavior notes.
- Removed all clangd/lm_clangd historical and current mentions from README, face-ai-report, and changelog text.

### 中文

#### 变更
- 精简 README 结构并减少重复长说明,同时保留当前行为说明.
- 从 README、face-ai-report、CHANGELOG 文本中移除全部 clangd/lm_clangd 相关描述.

## [1.0.99] - 2026-02-27

### English

#### Changed
- Extended `lm_qgrepSearchText.searchPath` and `lm_qgrepSearchFiles.searchPath` to support path-or-glob scopes (absolute, `WorkspaceName/...`, workspace-relative), including absolute and UNC glob patterns with plugin-side filtering.
- Added qgrep result observability fields and semantics: `maxResultsApplied` is always returned, `maxResultsRequested` is returned only when clamped, and `totalAvailableCapped` / `hardLimitHit` are returned only when hard-cap signals are triggered.
- Raised per-qgrep-call hard output limit from `2000` to `10000`, and aligned summary output and tool descriptions with the new cap behavior.
- Simplified and synchronized qgrep documentation in README and face-ai-report for glob scope behavior and truncation semantics.

### 中文

#### 变更
- 扩展 `lm_qgrepSearchText.searchPath` 与 `lm_qgrepSearchFiles.searchPath` 为 path-or-glob 范围,支持 absolute、`WorkspaceName/...`、workspace-relative,并支持 absolute/UNC glob,过滤在插件内完成.
- 增加并收敛 qgrep 结果可观测字段语义:`maxResultsApplied` 总是返回,`maxResultsRequested` 仅在钳制时返回,`totalAvailableCapped` 与 `hardLimitHit` 仅在触发硬限制时返回.
- 将每次 qgrep 调用的硬限制从 `2000` 提升到 `10000`,并同步 summary 输出与工具描述的上限语义.
- 精简并同步 README 与 face-ai-report 的 qgrep 文案,保持 glob 范围与截断语义一致.

## [1.0.98] - 2026-02-27

### English

#### Changed
- qgrep managed include sync now writes an Unreal include block for `*.ush`/`*.usf`/`*.ini` with explicit source annotation.
- Added a separate qgrep managed PowerShell include block for `*.ps1` with its own source annotation.
- Updated qgrep config-sync documentation in README and face-ai-report to reflect split managed include blocks.

### 中文

#### 变更
- qgrep 受管 include 同步现在会写入 Unreal include 区块(`*.ush`/`*.usf`/`*.ini`),并带有明确 source 标注.
- 新增独立的 qgrep 受管 PowerShell include 区块(`*.ps1`),并使用单独 source 标注.
- 更新 README 与 face-ai-report 中的 qgrep 配置同步说明,反映 include 区块拆分.

## [1.0.97] - 2026-02-27

### English

#### Changed
- Breaking change: renamed qgrep query tool IDs from `lm_qgrepSearch` to `lm_qgrepSearchText`, and from `lm_qgrepFiles` to `lm_qgrepSearchFiles`.
- Updated tool registration names, qgrep status auto-init hint payload text, and default exposed/enabled policy references to the new tool IDs.
- Updated README and face-ai-report current-behavior documentation to use the new qgrep tool IDs consistently.

### 中文

#### 变更
- Breaking change: 将 qgrep 查询工具 ID 从 `lm_qgrepSearch` 重命名为 `lm_qgrepSearchText`,并将 `lm_qgrepFiles` 重命名为 `lm_qgrepSearchFiles`.
- 已同步更新工具注册名、qgrep 状态自动初始化提示文本以及默认 exposed/enabled 策略中的工具 ID 引用。
- 已同步更新 README 与 face-ai-report 的当前行为文档,统一使用新的 qgrep 工具 ID。

## [1.0.96] - 2026-02-27

### English

#### Changed
- Updated status menu grouping and qgrep action visibility: add a separator below qgrep actions and show `Qgrep Init All Workspaces` only when no workspace is initialized; otherwise show `Qgrep Rebuild Indexes` and `Qgrep Stop And Clear Indexes`.
- Changed qgrep menu command scope to all current workspaces: `Qgrep Rebuild Indexes` now runs across all workspaces (auto-initializes per workspace when needed), and `Qgrep Stop And Clear Indexes` clears all workspaces.
- Adjusted default tool policy: `lm_findFiles` and `lm_findTextInFiles` are now default exposed but not default enabled.
- Updated qgrep default result limit to `300` for both `lm_qgrepSearch` and `lm_qgrepFiles` (runtime default and schema default).
- Simplified qgrep tool descriptions by removing the explicit sentence about blocking during in-progress index updates.

### 中文

#### 变更
- 调整状态菜单的 qgrep 分组与显示逻辑: 在 qgrep 操作下方新增分隔线,并在无已初始化 workspace 时仅显示 `Qgrep Init All Workspaces`; 存在已初始化 workspace 时仅显示 `Qgrep Rebuild Indexes` 与 `Qgrep Stop And Clear Indexes`.
- 将 qgrep 菜单命令作用范围统一为当前所有 workspace: `Qgrep Rebuild Indexes` 会对所有 workspace 执行(必要时按 workspace 自动初始化),`Qgrep Stop And Clear Indexes` 会清理所有 workspace.
- 调整默认工具策略: `lm_findFiles` 与 `lm_findTextInFiles` 改为默认 exposed,但默认不 enabled.
- 将 `lm_qgrepSearch` 与 `lm_qgrepFiles` 的默认结果上限更新为 `300`(运行时默认值与 schema 默认值同步更新).
- 精简 qgrep 工具描述,移除了“索引更新进行中会阻塞等待”的显式句子.

## [1.0.95] - 2026-02-26

### English

#### Added
- Added startup qgrep refresh behavior: already-initialized workspaces now queue one background `qgrep update` on extension startup to restore progress/file totals for the current session.
- Added `lm_qgrepSearch` smart-case default behavior (all-lowercase query => case-insensitive, query containing uppercase => case-sensitive) without changing the tool input schema.

#### Changed
- `Qgrep Stop And Clear Indexes` now cancels in-flight qgrep index commands (`init`/`update`/`build`) before deleting `.vscode/qgrep`, reducing misleading `workspace.cfg` read errors during clear.
- Improved qgrep runtime log signal quality by reducing expected-control-flow noise (including clear-cancel paths) and de-duplicating auto-update queue logs.
- `lm_qgrepFiles` no longer exposes the `caseInsensitive` input field; on Windows, file search now always passes qgrep `files` option `i` (case-insensitive).
- Updated tool descriptions/docs to clarify ripgrep-backed `lm_findFiles` / `lm_findTextInFiles` and qgrep performance positioning on indexed workspaces.

### 中文

#### Added
- 新增 qgrep 启动补刷新行为: 对已初始化的 workspace,扩展启动后会自动排队一次后台 `qgrep update`,用于恢复当前会话的进度/文件总数显示.
- 新增 `lm_qgrepSearch` 默认 smart-case 行为(全小写 query => 大小写不敏感,包含大写字母 => 大小写敏感),且不修改工具 input schema.

#### Changed
- `Qgrep Stop And Clear Indexes` 在删除 `.vscode/qgrep` 前会先取消进行中的 qgrep 索引命令(`init`/`update`/`build`),减少清理时误导性的 `workspace.cfg` 读取报错.
- 优化 qgrep 运行日志信噪比,降低预期控制流(包括 clear-cancel 路径)噪音,并减少 auto-update 排队日志重复输出.
- `lm_qgrepFiles` 不再暴露 `caseInsensitive` 输入字段; 在 Windows 平台下文件搜索会固定传入 qgrep `files` 的 `i` 选项(大小写不敏感).
- 更新工具描述与文档,明确 `lm_findFiles` / `lm_findTextInFiles` 基于 ripgrep 后端,以及 qgrep 在已索引 workspace 上的性能定位.

## [1.0.94] - 2026-02-26

### English

#### Added
- Added `lm_qgrepGetStatus` tool to inspect qgrep binary readiness, workspace init/watch state, and indexing progress (including aggregate progress) without requiring qgrep init.

#### Changed
- `lm_qgrepGetStatus` is now exposed and enabled by default so clients can check qgrep status before calling qgrep search tools.

#### Removed

### 中文

#### Added
- 新增 `lm_qgrepGetStatus` 工具,用于查看 qgrep binary 就绪状态、workspace 初始化/监听状态以及索引进度(含聚合进度),且不要求先完成 qgrep init.

#### Changed
- `lm_qgrepGetStatus` 现在默认 exposed 且默认 enabled,客户端可以在调用 qgrep 搜索工具前先检查 qgrep 状态.

#### Removed

## [1.0.93] - 2026-02-26

### English

#### Added
- Added `lm_qgrepFiles` tool for qgrep file search with `fp`, `fn`, `fs`, and `ff` modes.

#### Changed
- qgrep index maintenance now combines `watch` with debounced create/delete-triggered `qgrep update` refreshes.
- qgrep `workspace.cfg` now syncs a managed `search.exclude` block from VS Code `search.exclude=true` entries and always includes fixed excludes for `.git`, `Intermediate`, `DerivedDataCache`, `Saved`, `.vs`, and `.vscode`.

#### Fixed
- Hardened generated qgrep config regex output to avoid unsupported `(?...)` syntax that can break qgrep config parsing.

### 中文

#### 新增
- 新增 `lm_qgrepFiles` 工具,支持 qgrep 文件搜索 `fp`、`fn`、`fs`、`ff` 模式。

#### 变更
- qgrep 索引维护现在结合 `watch` 与基于 create/delete 事件的防抖 `qgrep update` 自动刷新。
- qgrep `workspace.cfg` 现在会从 VS Code `search.exclude=true` 条目同步受管区块,并固定排除 `.git`、`Intermediate`、`DerivedDataCache`、`Saved`、`.vs`、`.vscode`。

#### 修复
- 加固 qgrep 配置 regex 生成逻辑,避免输出 qgrep 不支持的 `(?...)` 语法导致配置解析失败。

## [1.0.92] - 2026-02-23

### English

#### Changed
- `resolveInputFilePath` now supports workspace-root relative paths in addition to `WorkspaceName/...` and absolute paths.
- Enforced path existence checks for resolved paths and added multi-root ambiguity handling for relative inputs.
- Updated `lm_getDiagnostics` input schema/docs to describe relative path support and disambiguation guidance.

### 中文

#### 变更
- `resolveInputFilePath` 现在除 `WorkspaceName/...` 与绝对路径外,还支持 workspace root 相对路径.
- 对解析后的路径统一增加存在性校验,并为多根 workspace 的相对路径加入歧义处理.
- 更新 `lm_getDiagnostics` 的 input schema 与文档说明,补充相对路径支持与消歧指引.

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
- Tightened forwarded LM tool mapping (`lm.invokeTool`): `content.text` is emitted only from upstream text parts, and `structuredContent` is emitted only for valid JSON object payloads; no cross-channel fallback copy is performed.
- Removed structured fallback wrapper generation (`{ blocks: [...] }`) for forwarded LM tool results when no valid structured object exists.

### 中文

#### 变更
- Breaking change: 移除旧的自定义工具兼容返回形态(`CustomToolInvokePayload`),并统一要求自定义工具直接返回 `LanguageModelToolResult`.
- 收紧上游 LM 工具转发映射(`lm.invokeTool`): `content.text` 仅在上游 text part 存在时输出,`structuredContent` 仅在上游返回合法 JSON object 时输出; 不再做跨通道回填复制.
- 移除上游 LM 工具结果在缺失 structured object 时的结构化回退包装(`{ blocks: [...] }`).

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

### 中文

#### 变更
- Breaking change: 自定义诊断工具由 `lm_getErrors` 更名为 `lm_getDiagnostics`.
- 不提供兼容 alias; 外部调用和本地配置需手动迁移到 `lm_getDiagnostics`.
- 保持工具行为和输出结构不变(输入仍为 `filePath`/`severities`/`maxResults`,输出仍为诊断摘要与结构化载荷).

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
- Removed legacy structured path fields (`summaryPath`, `location.path#...`) and dropped raw input echo fields from AI-first structured payloads.

### 中文

#### 变更
- 移除旧结构化路径字段(`summaryPath`,`location.path#...`),并清理 AI-first 结构化载荷中的输入回显字段.

## [1.0.62] - 2026-02-08

### English

#### Changed
- Added workspace-aware path parsing for `filePath`: `WorkspaceName/...` and absolute paths are accepted, `file:///...` is rejected.
- Improved `sourceByClass.startLine` for Unreal C++ types: when the previous line is `UCLASS(...)` or `USTRUCT(...)`, the macro line is reported as the start line.

### 中文

#### 变更
- 新增工作区感知 `filePath` 解析: 接受 `WorkspaceName/...` 和绝对路径,拒绝 `file:///...`.
- 优化 Unreal C++ 类型的 `sourceByClass.startLine`: 当前一行是 `UCLASS(...)` 或 `USTRUCT(...)` 宏时,起始行会上移到宏所在行.

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

#### Fixed
- Fixed blank tool-configuration webview caused by invalid JSON state serialization in the embedded `application/json` script block.

### 中文

#### 变更
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
