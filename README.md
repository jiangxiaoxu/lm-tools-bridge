# LM Tools Bridge

[English](#english) | [中文](#中文)

## English

### Overview
LM Tools Bridge is a VS Code extension that exposes LM tools through MCP.
Each workspace VS Code instance hosts a local MCP HTTP server, while external clients connect through a per-session stdio manager.

### Quick Start
1. Start service in VS Code: `LM Tools Bridge: Start Server`.
2. Launch one stdio MCP process per client session: `node <extension-dir>/out/stdioManager.js`.
3. Call handshake tool `lmToolsBridge.requestWorkspaceMCPServer` with `{ "cwd": "<project path>" }` (Windows accepts only normal absolute paths and `\\?\` + normal absolute paths; prefix matching is case-insensitive).
4. After handshake, call bridged workspace tools from `tools/list`, or keep using `lmToolsBridge.callTool`.

### Endpoints
- Stdio manager entry: `node <extension-dir>/out/stdioManager.js`
- Workspace MCP (internal, dynamic): `http://127.0.0.1:<runtime-port>/mcp`
- Workspace health (internal): `http://127.0.0.1:<runtime-port>/mcp/health`

### Core Behavior
- Always connect clients to the stdio manager, not workspace runtime ports.
- Handshake is required before calling bridged workspace tools.
- Each client session should launch its own stdio manager process. Multiple managers can run concurrently and route independently.
- On Windows, handshake can auto-start the matching VS Code workspace instance, wait until it registers and becomes healthy, then bind to it.
- On Windows, launch-target resolution walks upward level by level; at each level it checks `.code-workspace`, then `.vscode`, then `.git`, and only moves to the parent when that level has none of them.
- Auto-start happens only during handshake. If the bound workspace instance closes later, follow-up calls return offline/rebind errors and do not trigger restart.
- Handshake and direct-call metadata stay concise; actionable recovery guidance is returned through `guidance` fields and manager error messages.
- Manager JSON-RPC errors include actionable `Next step:` recovery hints in `error.message`.
- Successful `lmToolsBridge.requestWorkspaceMCPServer` responses include `guidance`, `discovery`, and dynamic bridged tool metadata while omitting redundant top-level `online` and `health`.
- After handshake, `tools/list` dynamically merges bridged workspace tools into the local stdio manager tool list.
- No manager status/log web pages are provided.

### Built-in Tool Summary

#### Search
- `lm_findFiles`: VS Code workspace file search (ripgrep backend).
- `lm_findFiles.query` always uses glob semantics and does not support `|` alternation; use brace globs such as `{A,B}`.
- `lm_findTextInFiles`: VS Code workspace text search (ripgrep backend).
- `lm_findTextInFiles` accepts `query/caseSensitive/querySyntax/includePattern/maxResults/includeIgnoredFiles`.
- `lm_findTextInFiles` defaults to `querySyntax='literal'`; set `querySyntax='regex'` for regular expressions. `includePattern` is a path-or-glob scope and does not support `|` alternation.
- `lm_findTextInFiles` no longer supports legacy `isRegexp`.
- Default policy: both are exposed by default, but not enabled by default.

#### Diagnostics
- `lm_getDiagnostics` reads from `vscode.languages.getDiagnostics`.
- Supports `filePaths`, `severities`, and `maxResults` (default `100`).
- Severity defaults to `error` + `warning`.

#### Qgrep
- `lm_qgrepGetStatus`: qgrep binary/workspace/index readiness snapshot (plain-text output).
- `lm_qgrepSearchText`: text search via bundled `bin/qgrep.exe` (`query/caseSensitive/querySyntax/includePattern/maxResults/beforeContextLines/afterContextLines`).
- `lm_qgrepSearchText` defaults to `querySyntax='glob'`; set `querySyntax='regex'` to switch to regex mode.
- In glob mode, `lm_qgrepSearchText.query` follows VS Code glob semantics (`*`, `?`, `**`, `[]`, `[!...]`, `{a,b}`).
- In text glob mode, `*` and `?` do not match `/`, while `**` can match across `/`.
- In text glob mode, matching is substring-based and does not apply implicit `^...$` anchoring.
- `beforeContextLines` and `afterContextLines` control preview context lines (`0-20`, default `0`), and output always includes line numbers.
- When context lines are enabled, extra true matches that fall inside the selected context windows are still rendered as match lines (`:`); this does not expand windows or change result counts.
- `lm_qgrepSearchText` supports `includePattern` and does not support `searchPath` or `includeIgnoredFiles`.
- `lm_qgrepSearchText.includePattern` accepts absolute paths, `WorkspaceName/...`, `{WorkspaceA,WorkspaceB}/...`, and workspace-relative globs. It does not support `|` alternation; use brace globs such as `{A,B}` or move alternation into `query` with `querySyntax='regex'`.
- `lm_qgrepSearchText` no longer supports legacy `isRegexp`.
- `lm_qgrepSearchFiles`: indexed file search via `query/querySyntax/maxResults` (default glob, optional regex, plain-text output).
- In glob mode, `lm_qgrepSearchFiles.query` follows VS Code glob semantics (`*`, `?`, `**`, `[]`, `[!...]`, `{a,b}`).
- In files glob mode, queries without `/` match any depth (for example, `*.md` behaves like `**/*.md`).
- In multi-root workspaces, `WorkspaceName/<glob>` scopes to one workspace, and `{WorkspaceA,WorkspaceB}/<glob>` aggregates only the selected workspaces.
- In files glob mode, matching is performed against file paths, not file contents, and uses whole-path anchoring rather than substring matching.
- In files glob mode, `lm_qgrepSearchFiles.query` does not support `|` alternation; use brace globs such as `{A,B}` or set `querySyntax='regex'`.
- `lm_qgrepSearchFiles` defaults to `querySyntax='glob'`, supports `querySyntax='regex'`, and no longer supports legacy `mode`, `searchPath`, or `isRegexp` inputs.
- qgrep search/files outputs use absolute paths with `/` separators; text output uses `====` for file switches and `---` for same-file context blocks.
- qgrep files output has a single `====` header separator, followed by one absolute path per line.
- `lm_qgrepSearchText` and `lm_qgrepSearchFiles` auto-init all current workspaces and wait until ready (timeout `150s`).
- Startup refresh for already initialized workspaces now syncs extension-managed `workspace.cfg` blocks before `qgrep update`.
- During startup refresh, if qgrep reports a corruption-like assertion signature (`Assertion failed` with `filter.cpp`/`entries.entries`), the extension auto-runs one rebuild attempt per workspace for this startup session.
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
- `workspace not set`: rerun handshake.
- `workspace not matched`: ensure `cwd` is inside the target workspace or points to the target `.code-workspace` file (Windows `cwd` must be a normal absolute path or `\\?\` + normal absolute path; non-normal NT namespace forms are rejected).
- `Resolved workspace MCP server is offline`: the bound VS Code instance closed after handshake. Rerun handshake to rebind. Follow-up calls do not auto-restart it.
- Handshake startup/wait timed out on Windows: ensure `code.cmd` or `code` is available on `PATH`, then retry handshake.
- qgrep waits too long: check `lm_qgrepGetStatus`.
- If qgrep still reports assertion failures after startup auto-repair, run `LM Tools Bridge: Qgrep Rebuild Indexes` and retry once.
- `Tool not found or disabled`: ensure tool is both exposed and enabled.
- For handshake/direct-call errors, follow the `Next step:` hint in the returned `error.message` before using shell fallback.

### Change History
See `CHANGELOG.md`.

---

## 中文

### 概览
LM Tools Bridge 是一个 VS Code 扩展,用于通过 MCP 暴露 LM tools.
每个 workspace 的 VS Code 实例会托管本地 MCP HTTP server,外部客户端则通过每会话一个 stdio manager 接入.

### 快速开始
1. 在 VS Code 里执行 `LM Tools Bridge: Start Server`.
2. 每个客户端会话拉起一个 stdio MCP 进程: `node <extension-dir>/out/stdioManager.js`.
3. 先调用握手工具 `lmToolsBridge.requestWorkspaceMCPServer`,参数 `{ "cwd": "<project path>" }`(Windows 仅接受普通绝对路径和 `\\?\` + 普通绝对路径,前缀匹配不区分大小写).
4. 握手成功后,直接从 `tools/list` 调用桥接后的 workspace tools,或者继续使用 `lmToolsBridge.callTool`.

### 端点
- Stdio manager 入口: `node <extension-dir>/out/stdioManager.js`
- Workspace MCP(内部动态端口): `http://127.0.0.1:<runtime-port>/mcp`
- Workspace health(内部): `http://127.0.0.1:<runtime-port>/mcp/health`

### 核心行为
- 客户端应始终连接 stdio manager,不要直连 workspace 动态端口.
- 调用 workspace 桥接工具前,必须先握手.
- 每个客户端会话应各自拉起一个 stdio manager 进程,多个 manager 可以并发运行并独立路由.
- 在 Windows 上,握手阶段会在需要时尝试自动拉起匹配的 VS Code workspace 实例,等待其注册并健康后再完成绑定.
- 在 Windows 上,启动目标会按层级逐级向上解析; 每一层都会先查 `.code-workspace`,再查 `.vscode`,再查 `.git`,这一层都没有才继续查父目录.
- 自动拉起只发生在握手阶段. 如果后续绑定的 workspace 实例关闭,后续调用会返回 offline/rebind 错误,不会自动重启.
- 握手与 direct-call 元信息保持精简; 可执行恢复指引通过 `guidance` 字段和 manager 错误消息返回.
- Manager JSON-RPC 错误会在 `error.message` 中附带可执行的 `Next step:` 恢复提示.
- 成功的 `lmToolsBridge.requestWorkspaceMCPServer` 返回会包含 `guidance`,`discovery` 以及桥接工具元信息,同时省略冗余的顶层 `online` 和 `health`.
- 握手成功后,`tools/list` 会动态合并当前 workspace 的桥接工具.
- 不再提供 manager status/log 网页端点.

### 内置工具摘要

#### 搜索
- `lm_findFiles`: 使用 VS Code workspace 文件搜索(后端 ripgrep).
- `lm_findFiles.query` 始终使用 glob 语义,不支持 `|` alternation; 需要多分支请用 `{A,B}`.
- `lm_findTextInFiles`: 使用 VS Code workspace 文本搜索(后端 ripgrep).
- `lm_findTextInFiles` 支持 `query/caseSensitive/querySyntax/includePattern/maxResults/includeIgnoredFiles`.
- `lm_findTextInFiles` 默认 `querySyntax='literal'`; 传 `querySyntax='regex'` 切换到 regex. `includePattern` 是 path-or-glob scope,不支持 `|` alternation.
- `lm_findTextInFiles` 不再支持旧的 `isRegexp` 输入.
- 默认策略: 两者默认 exposed,默认不 enabled.

#### 诊断
- `lm_getDiagnostics` 基于 `vscode.languages.getDiagnostics`.
- 支持 `filePaths`,`severities`,`maxResults`(默认 `100`).
- `severities` 未传时默认 `error` + `warning`.

#### Qgrep
- `lm_qgrepGetStatus`: 返回 qgrep binary/workspace/index 就绪快照(纯文本输出).
- `lm_qgrepSearchText`: 通过内置 `bin/qgrep.exe` 做文本搜索(`query/caseSensitive/querySyntax/includePattern/maxResults/beforeContextLines/afterContextLines`).
- `lm_qgrepSearchText` 默认使用 `querySyntax='glob'`; 传 `querySyntax='regex'` 切换到 regex 模式.
- 在 glob 模式下,`lm_qgrepSearchText.query` 遵循 VS Code glob 语义(`*`,`?`,`**`,`[]`,`[!...]`,`{a,b}`).
- 文本 glob 模式下,`*` 和 `?` 不匹配 `/`,`**` 可以跨 `/` 匹配.
- 文本 glob 模式下,匹配采用 substring 方式,不会隐式添加 `^...$` 锚定.
- `beforeContextLines` 和 `afterContextLines` 控制预览上下文行(`0-20`,默认 `0`),输出始终包含行号.
- 开启上下文行后,若所选上下文窗口内还有额外真实命中,这些行也会继续按命中行(`:`)显示,但不会扩展窗口或改变结果计数.
- `lm_qgrepSearchText` 支持 `includePattern`,不支持 `searchPath` 和 `includeIgnoredFiles`.
- `lm_qgrepSearchText.includePattern` 支持 absolute path,`WorkspaceName/...`,`{WorkspaceA,WorkspaceB}/...` 和 workspace-relative glob. 它不支持 `|` alternation; 需要多分支请用 `{A,B}`,或把 alternation 放到 `query` 并设置 `querySyntax='regex'`.
- `lm_qgrepSearchText` 不再支持旧的 `isRegexp` 输入.
- `lm_qgrepSearchFiles`: 使用 `query/querySyntax/maxResults` 做索引文件搜索(默认 glob,可切 regex,纯文本输出).
- 在 glob 模式下,`lm_qgrepSearchFiles.query` 遵循 VS Code glob 语义(`*`,`?`,`**`,`[]`,`[!...]`,`{a,b}`).
- 文件 glob 模式下,不含 `/` 的查询会匹配任意目录深度(例如 `*.md` 等价 `**/*.md`).
- 在 multi-root workspace 中,`WorkspaceName/<glob>` 会限定到单个 workspace,`{WorkspaceA,WorkspaceB}/<glob>` 只会聚合被选中的 workspace.
- 文件 glob 模式下,匹配对象是 file path 而不是 file content,并且采用整路径锚定匹配,不是 substring 匹配.
- 文件 glob 模式下,`lm_qgrepSearchFiles.query` 不支持 `|` alternation; 需要多分支请用 `{A,B}`,或者切到 `querySyntax='regex'`.
- `lm_qgrepSearchFiles` 默认 `querySyntax='glob'`,支持 `querySyntax='regex'`,并且不再支持旧的 `mode`,`searchPath` 和 `isRegexp` 输入.
- qgrep search/files 输出使用绝对路径并统一 `/` 分隔符; 文本搜索里 `====` 用于文件切换,`---` 用于同文件上下文分块.
- qgrep files 输出仅在头部使用一个 `====`,后续每行一个绝对路径.
- `lm_qgrepSearchText` 和 `lm_qgrepSearchFiles` 会按需自动初始化当前全部 workspace,并等待到就绪(超时 `150s`).
- 对已初始化 workspace,扩展启动后的后台刷新会先同步插件受管 `workspace.cfg` 区块,再执行 `qgrep update`.
- 启动刷新阶段若 qgrep 返回坏索引特征断言(`Assertion failed` 且包含 `filter.cpp`/`entries.entries`),插件会在本次启动周期内对该 workspace 自动尝试一次重建.
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
- `workspace not set`: 重新握手.
- `workspace not matched`: 检查 `cwd` 是否位于目标 workspace 内,或者是否直接指向目标 `.code-workspace` 文件(Windows `cwd` 仅支持普通绝对路径和 `\\?\` + 普通绝对路径,非普通 NT namespace 写法会被拒绝).
- `Resolved workspace MCP server is offline`: 说明握手后的目标 VS Code 实例已经关闭. 重新握手即可重新绑定,后续调用不会自动重启它.
- Windows 上握手启动/等待超时: 确认 `code.cmd` 或 `code` 已在 `PATH` 中,然后重新握手.
- qgrep 等待过久: 先看 `lm_qgrepGetStatus`.
- 如果启动自动修复后仍出现 qgrep 断言错误,执行 `LM Tools Bridge: Qgrep Rebuild Indexes` 后重试一次.
- `Tool not found or disabled`: 确认工具同时处于 exposed 与 enabled.
- 遇到握手或 direct-call 相关错误时,优先按返回 `error.message` 里的 `Next step:` 执行恢复,再考虑 shell fallback.

### 变更历史
参见 `CHANGELOG.md`.
