# clangd MCP 实施手册与进度追踪

## Title + Metadata
- Project: clangd MCP integration for `lm-tools-bridge`
- Created: 2026-02-06
- Last updated: 2026-02-08
- Status: In Progress
- Current milestone: M6 - Validation, hardening, and handoff
- Owner: Codex + repository maintainer

## Goals and Success Criteria
### Goals
- 在 `src/clangd/` 下实现低耦合 clangd MCP 模块.
- 保持 `src/tooling.ts` 仅作为接入层, 不承载 clangd 业务逻辑.
- 支持 clangd 按需自动启动(auto start on invoke).
- 保障长会话和上下文中断后的可恢复执行.

### Success Criteria
- `src/tooling.ts` 不包含 clangd 业务实现.
- `lm_clangd_*` 工具可出现在 MCP `tools/list`.
- 指导手册可独立指导后续实现和排障.
- 核心验证项可被明确勾选完成或给出阻塞原因.

## Non-goals
- 不修改 `G:\UE_Folder\vscode-clangd` 源码.
- 不暴露 UI 依赖型 clangd command.
- 不将该手册拆分为多文件.
- 不实现与 clangd MCP 无关的功能.

## Public APIs/Interfaces/Types
### Planned MCP tools
- `lm_clangd_status`
- `lm_clangd_switchSourceHeader`
- `lm_clangd_typeHierarchy`
- `lm_clangd_symbolSearch`
- `lm_clangd_symbolBundle`
- `lm_clangd_symbolInfo`
- `lm_clangd_symbolReferences`
- `lm_clangd_symbolImplementations`
- `lm_clangd_callHierarchy`
- `lm_clangd_lspRequest` (allowlist 限制)

### Planned configuration keys
- `lmToolsBridge.clangd.enabled`
- `lmToolsBridge.clangd.autoStartOnInvoke`
- `lmToolsBridge.clangd.enablePassthrough`
- `lmToolsBridge.clangd.requestTimeoutMs`
- `lmToolsBridge.clangd.allowedMethods`

### Planned internal interfaces
- `getClangdToolsSnapshot`
- `ensureClangdRunning`
- `sendRequestWithAutoStart`

### Planned module layout
- `src/clangd/index.ts`
- `src/clangd/client.ts`
- `src/clangd/bootstrap.ts`
- `src/clangd/transport.ts`
- `src/clangd/methods.ts`
- `src/clangd/types.ts`
- `src/clangd/schemas.ts`
- `src/clangd/errors.ts`
- `src/clangd/tools/*.ts`

## Implementation Milestones
### M1 - Architecture and module scaffold
- Goal: 建立独立 clangd 模块边界和接入契约.
- Tasks:
- [x] 创建 `src/clangd/` 和基础文件(`index.ts`, `types.ts`, `methods.ts`, `errors.ts`).
- [x] 定义 method 常量和请求/响应类型骨架.
- [x] 定义 `lm_clangd_*` 输入 schema 合同.
- [x] 明确导入边界: `tooling.ts -> clangd/index.ts`.
- DoD:
- [x] 模块树存在并可编译.
- [x] `tooling.ts` 中未写入 clangd 业务逻辑.
- Risks:
- clangd API 版本变化可能导致类型漂移.

### M2 - Client access and auto-start bootstrap
- Goal: clangd client 可懒加载并按需自动启动.
- Tasks:
- [x] 实现 `llvm-vs-code-extensions.vscode-clangd` 扩展发现.
- [x] 实现 `ensureClangdRunning` 启动前检查.
- [x] 当 client 不可用时触发一次 `clangd.activate`.
- [x] 增加超时等待和启动失败错误映射.
- DoD:
- [x] 首次调用在 clangd 未运行时可触发自动启动路径.
- [x] `clangd.enable=false` 路径不改用户设置并返回明确错误.
- Risks:
- 并发调用时可能出现启动竞态.

### M3 - Tool implementations (read-only set)
- Goal: 实现稳定只读 clangd MCP 工具集合.
- Tasks:
- [x] 实现 `lm_clangd_status`.
- [x] 实现 `lm_clangd_switchSourceHeader`.
- [x] 实现并后续按策略下线 `lm_clangd_ast`.
- [x] 实现 `lm_clangd_typeHierarchy`.
- [x] 剪裁低价值工具暴露(`lm_clangd_memoryUsage`, `lm_clangd_inlayHints`).
- DoD:
- [x] 工具输出可进入现有 text/structured 结果链路.
- [x] 输入错误可返回明确错误信息.
- Risks:
- AST 和 hierarchy 返回体可能较大.

### M4 - Restricted passthrough and policy guardrails
- Goal: 提供受控兜底能力, 不扩大风险面.
- Tasks:
- [x] 实现 `lm_clangd_lspRequest`.
- [x] 按 `lmToolsBridge.clangd.allowedMethods` 做 allowlist 校验.
- [x] 非 allowlist method 默认拒绝.
- [x] 支持 `lmToolsBridge.clangd.requestTimeoutMs` 超时控制.
- DoD:
- [x] 非 allowlist method 一致被拒绝.
- [x] allowlist method 走统一 transport 封装.
- Risks:
- allowlist 配置错误会导致误拒绝.

### M5 - Integration, docs, and changelog
- Goal: 接入主链路并同步文档.
- Tasks:
- [x] 将 `getClangdToolsSnapshot` 接入 custom tools 聚合.
- [x] 更新 `README.md` (clangd 工具、配置、自动启动说明).
- [x] 更新 `CHANGELOG.md`.
- [x] 更新 `face-ai-report.md`.
- [x] 更新 `src/README.md` 模块结构说明.
- [x] 新增 `clangd-tools-reference.md` (工具描述 + input/output schema).
- DoD:
- [x] 文档与实现行为保持一致.
- [x] 变更记录可读并位于顶部.
- Risks:
- 后续行为微调可能引起文档偏差.

### M6 - Validation, hardening, and handoff
- Goal: 完成校验并形成可交接状态.
- Tasks:
- [x] 运行 `npm run compile`.
- [ ] 验证 manager handshake + schema-read-before-call 流程.
- [ ] 验证 clangd 未运行时自动拉起路径.
- [ ] 验证 `clangd.enable=false` 失败路径.
- [ ] 根据验证结果补全 tracker 和 decision log.
- DoD:
- [ ] Validation checklist 全量勾选, 或明确阻塞项.
- [ ] 状态更新为 `Done` 或 `Blocked`.
- Risks:
- 运行时验证依赖 Extension Development Host 环境.

## Progress Tracker
### Current milestone
- M6 - Validation, hardening, and handoff

### Completed
- [x] `src/clangd/` 独立模块实现完成.
- [x] `tooling.ts` 最小接入完成.
- [x] `package.json` clangd 配置项完成.
- [x] `README.md`, `CHANGELOG.md`, `face-ai-report.md`, `src/README.md` 已更新.
- [x] `clangd-tools-reference.md` 已新增并同步当前默认暴露工具.
- [x] 低价值项剪裁完成(工具暴露与默认 passthrough 清单).
- [x] line/character 输入输出已统一为 1-based(含自动边界转换).
- [x] `npm run compile` 已通过.
- [x] 工具配置页升级为来源分组树形 UI, 便于筛选与管理 `lm_clangd_*` 工具暴露.
- [x] 工具选择模型升级为 exposure/enabled 双层 delta, 并在 unexposed 时自动清理 enabled delta.
- [x] Exposure 底部新增 `Built-in Disabled` 父分组和来源子分组并启用硬禁用约束, 禁用工具不可暴露不可启用.
- [x] settings 归一化扩展为同时清理内置禁用工具在四个 delta 中的无效项.
- [x] 树形配置页状态传输改为 base64 初始化, 修复空白页风险并保留 QuickPick 回退.
- [x] `lm_clangd_typeHierarchy` 改为结构化摘要输出(`root/supers/derivedByParent/sourceByClass/limits/truncated`),并支持 `maxSuperDepth/maxSubDepth/maxSubBreadth` 边界输入.
- [x] `lm_clangd_typeHierarchy.sourceByClass` 增加 Unreal 宏感知起始行归一化: 若声明前一行是 `UCLASS/USTRUCT` 宏,则将 `startLine` 对齐到宏行.
- [x] clangd AI-first 输入路径契约统一为 `filePath`,支持 `WorkspaceName/...` 与绝对路径,移除 `uri` 输入兼容.
- [x] clangd AI-first 输出协议统一为摘要文本(`counts + --- + entries`),路径渲染为 `WorkspaceName/...#line` 或绝对路径.
- [x] 新增符号/关系工具: `lm_clangd_symbolSearch`, `lm_clangd_symbolBundle`, `lm_clangd_symbolInfo`, `lm_clangd_symbolReferences`, `lm_clangd_symbolImplementations`, `lm_clangd_callHierarchy`.
- [x] clangd AI-first 工具补充 `structuredContent`,提供与摘要文本等价的稳定机读载荷.
- [x] `lm_clangd_symbolSearch` 默认补充完整签名并在 `structuredContent` 提供 `signature/signatureSource` 字段.
- [x] `lm_clangd_symbolInfo` 的 snippet 默认排除 generated 文件来源(`*.generated.h`, `*.gen.cpp`),且不回退到 generated 位置.
- [x] `lm_clangd_typeHierarchy` 的 SOURCE 文本顺序调整为 `type -> preview -> path`,并在 `sourceByClass` 增加 `preview` 字段.
- [x] `lm_clangd_typeHierarchy` 区间校正切换为 `documentSymbol` 唯一来源: 命中则用符号范围,未命中则回退单行(`endLine = startLine`).
- [x] clangd structured 路径字段统一为 `absolutePath` + `workspacePath`,并移除 `summaryPath/location.path#...` 与输入回显字段.
- [x] `lm_clangd_ast` 已从 clangd 工具暴露与默认 exposed/enabled 列表中下线.
- [x] `lm_clangd_symbolInfo` 增加基于 documentSymbol 的符号类别自适应输出,并按需提供 `typeDefinition` 条目.

### In progress
- [ ] 运行时链路验证(handshake + clangd 自动启动).

### Next
- [ ] 在 Extension Development Host 执行 `lmToolsBridge.requestWorkspaceMCPServer`.
- [ ] 读取 `lm-tools://schema/lm_clangd_status` 并调用 `lm_clangd_status`.
- [ ] 在 clangd 未运行时调用 `lm_clangd_typeHierarchy` 验证自动拉起.
- [ ] 设置 `clangd.enable=false` 验证非侵入失败路径.

### Blocked
- [ ] 当前无阻塞.

### Decision log
- 2026-02-06: 使用 `src/clangd/` 子模块拆分. Reason: 降低耦合并提升可维护性.
- 2026-02-06: 启用按需自动启动. Reason: 保证 clangd 未启动时的可用性.
- 2026-02-06: `clangd.enable=false` 时仅尝试一次启动且不改用户配置. Reason: 避免隐式修改用户设置.
- 2026-02-06: `lmToolsBridge.clangd.enabled` 默认值设为 `false`. Reason: 避免在未显式开启时暴露额外工具面.
- 2026-02-06: `allowedMethods=[]` 时回退内置只读 allowlist. Reason: 提供安全默认可用行为.
- 2026-02-06: `allowedMethods` 强制只读白名单交集. Reason: 明确禁止非只读调用并降低风险面.
- 2026-02-06: 剪裁低价值能力(`lm_clangd_memoryUsage`, `lm_clangd_inlayHints`, completion, semanticTokens). Reason: 聚焦高价值只读导航与签名分析场景.
- 2026-02-06: line/character 输入输出统一为 1-based. Reason: 提升人类核查与手工定位效率, 在 LSP 边界自动完成 1-based<->0-based 转换.
- 2026-02-07: 工具配置入口改为来源分组树形面板(含组级勾选与搜索). Reason: 提升大工具集下的可筛选性和操作效率.
- 2026-02-07: 工具配置改为 exposure/enabled 双层 delta, 且 unexposed 时自动清理 enabled delta. Reason: 消除无效配置并确保暴露约束与启用状态强一致.
- 2026-02-07: DEFAULT_ENABLED_TOOL_NAMES 内工具强制暴露并在 Exposure UI 中设为只读. Reason: 防止误操作破坏核心默认工具可见性.
- 2026-02-07: 内置禁用名单恢复为最高优先级, 并在 Exposure 底部分组单独显示. Reason: 保留安全边界且提升配置可解释性.
- 2026-02-07: 工具配置 webview 初始状态改为 base64 载荷解码. Reason: 避免 script 内嵌 JSON 解析异常导致空白页.
- 2026-02-08: `lm_clangd_typeHierarchy` 从透传 raw item 调整为稳定摘要输出并引入可配置上下界. Reason: 提升结果可读性,便于 C++ 继承链分析和人工核查.
- 2026-02-08: `sourceByClass.startLine` 增加 Unreal 宏行归一化. Reason: UE 类型声明通常由 `UCLASS/USTRUCT` 宏起始,仅返回声明行会影响人工核查准确性.
- 2026-02-08: 移除 `lm_clangd_typeHierarchyResolve` 工具暴露与实现入口. Reason: `lm_clangd_typeHierarchy` 已提供稳定摘要输出,保留 resolve 工具会增加低价值维护面.
- 2026-02-08: clangd AI-first 工具统一 `filePath` 输入并弃用 `uri` 参数. Reason: 对齐 AI 任务输入习惯并减少 URI 处理噪音.
- 2026-02-08: clangd AI-first 工具统一摘要文本输出与工作区路径渲染. Reason: 提高 AI 直接消费效率并强化跨项目可读性.
- 2026-02-08: `lm_clangd_symbolSearch` 默认返回完整签名并启用 `signatureHelp -> hover -> definitionLine` 回退链路. Reason: 提升单次搜索的信息密度并减少后续补查调用.
- 2026-02-08: `lm_clangd_symbolInfo` snippet 选点排除 generated 文件,且不再回退到 generated. Reason: 避免 UHT 生成代码片段干扰 AI 代码理解主路径.
- 2026-02-08: `lm_clangd_typeHierarchy` SOURCE 条目顺序改为 `type -> preview -> path`,并在结构化结果补充 `preview`. Reason: 提升 AI 对类型信息和定位预览的快速理解效率.
- 2026-02-08: `lm_clangd_typeHierarchy` 结束行策略改为仅依赖 `textDocument/documentSymbol`; 未匹配时强制回退为单行区间. Reason: 避免本地扫描猜测导致区间偏差,优先 clangd 语义结果.
- 2026-02-08: clangd structured 路径字段统一为 `absolutePath + workspacePath`,并移除 `summaryPath/path#...` 与输入回显字段. Reason: 提升 AI 机读稳定性并避免路径语义混淆.
- 2026-02-08: 下线 `lm_clangd_ast` 工具暴露. Reason: 降低低价值高噪音输出,聚焦符号/关系类 AI-first 工具链路.
- 2026-02-08: `lm_clangd_symbolInfo` 按符号类别自适应输出(`callable/valueLike/typeLike/...`),并仅在有意义场景返回 `typeDefinition`. Reason: 降低无效输出噪音并减少 AI 二次筛选成本.

## Validation Checklist
- [x] `npm run compile` passes.
- [ ] MCP handshake via `lmToolsBridge.requestWorkspaceMCPServer` succeeds.
- [ ] `resources/read lm-tools://schema/{name}` works for all `lm_clangd_*` tools.
- [ ] `tools/call` succeeds for implemented clangd tools.
- [ ] Auto-start on invoke works when clangd is initially not running.
- [ ] `clangd.enable=false` path returns expected non-mutating failure behavior.
- [ ] Non-allowlisted method is rejected in `lm_clangd_lspRequest`.

## Rollback Plan
### Soft rollback
- 从 custom tool 聚合中移除 `getClangdToolsSnapshot`.
- 保留 `src/clangd/` 代码但停止暴露.
- 同步更新文档为回滚状态.

### Hard rollback
- 删除 `src/clangd/` 目录和 `lmToolsBridge.clangd.*` 配置项.
- 回退 `README.md`, `CHANGELOG.md`, `face-ai-report.md`, 本手册中的对应条目.

## Context Recovery Protocol
### First read order after context loss
1. 读取 `Progress Tracker -> Current milestone`.
2. 读取 `Decision log`.
3. 读取 `Progress Tracker -> Next`.
4. 从首个未勾选 `Next` 项继续执行.

### Resume execution sequence
1. 确认当前里程碑 DoD 和风险.
2. 仅执行当前里程碑范围内任务.
3. 更新 `Completed`, `In progress`, `Next`, `Last updated`.
4. 若策略变化, 追加 `Decision log` 新条目(日期 + 原因).

### Mandatory update fields after each change
- `Last updated`
- `Status`
- `Current milestone` (如已切换)
- `Progress Tracker` 各子段
- `Decision log` (仅策略变化时)

## Weekly/Session Update Template
使用模板记录每次会话收口.

```md
### Session update - YYYY-MM-DD
- Summary:
- Milestone:
- Completed:
  - [ ] item
- In progress:
  - [ ] item
- Next:
  - [ ] item
- Risks:
- Decisions:
  - YYYY-MM-DD: decision, reason
```

## Assumptions and Defaults
- 手册路径固定: `clangd-mcp-implementation-guide.md` (repo 根目录).
- 进度粒度固定: milestone + task checklist.
- 本手册是 clangd MCP 实施进度的 single source of truth.
- 代码实施过程中, 每完成一个任务都必须回写本手册.
