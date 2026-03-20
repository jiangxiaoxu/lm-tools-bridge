# LM Tools Bridge

[English](#english) | [中文](#中文)

## English

### Overview
LM Tools Bridge is a VS Code extension that exposes workspace tools through MCP.
External MCP clients connect to a local stdio manager, then bind to the target VS Code workspace instance.

This extension currently supports Windows only.

### Prerequisites
- VS Code
- Node.js available on `PATH`

If Node.js is missing, the extension shows a startup warning with `Install with winget` and `Download Node.js`.

### Install And First Launch
1. Install the extension in VS Code.
2. Open the target folder or `.code-workspace` in VS Code.
3. Let the extension activate once so it syncs `stdioManager.js` to `%LOCALAPPDATA%\lm-tools-bridge\stdioManager.js`.
4. The MCP server starts automatically when the extension activates.

### Codex MCP Config
Recommended Codex config:

```toml
[mcp_servers.lm_tools_bridge]
command = "powershell.exe"
args = [
  "-NoProfile",
  "-Command",
  "node \"$env:LOCALAPPDATA\\lm-tools-bridge\\stdioManager.js\""
]
enabled = true
```

The PowerShell wrapper is recommended because many MCP clients do not expand environment variables inside raw args.

### Codex Skill
For the best Codex app experience, use this extension together with the `vscode-tools` skill.

In Codex app, install it with:

```text
$skill-installer install https://github.com/jiangxiaoxu/lm-tools-bridge/tree/master/skills/vscode-tools
```

Restart Codex to pick up the new skill.

### Basic Usage
1. Start one stdio manager per client session.
2. Call `lmToolsBridge.requestWorkspaceMCPServer`.
3. Pass `cwd` as either:
   - the target project path
   - the target `.code-workspace` file path
4. After handshake succeeds, use the bridged tools from `tools/list`, or continue using `lmToolsBridge.callTool`.

Notes:
- Handshake is required before calling bridged workspace tools.
- Successful handshake payloads expose workspace identity (`workspaceFolders`, `workspaceFile`), `discovery`, and `guidance`, but do not expose manager session ids or workspace transport `host`/`port`.
- If the target VS Code instance does not exist yet, handshake will try to start the matching VS Code instance first.
- On Windows, handshake resolves the launch target from `cwd` like this:
  - if `cwd` is a `.code-workspace` file, use it directly
  - if `cwd` is a file, start from its parent directory
  - otherwise walk upward level by level, checking `.code-workspace`, then `.vscode`, then `.git`
  - if nothing matches at every level, use the current directory
- If the bound VS Code instance closes later, rerun handshake. It will not auto-restart after binding.

### Search Notes
- All `pathScope` fields share `lm-tools://spec/pathScope`. Read it once and reuse the same syntax across `lm_findTextInFiles`, `lm_qgrepSearchText`, and `lm_getDiagnostics`.
- The shared `pathScope` syntax supports `<glob>`, `WorkspaceName/<glob>`, `{WorkspaceA,WorkspaceB}/<glob>`, mixed top-level brace branches, and absolute paths or globs inside the current workspaces.
- `lm_qgrepSearchText.pathScope` and `lm_qgrepSearchFiles.query` use VS Code glob semantics, including brace globs.
- qgrep-managed Unreal include rules also index `*.uplugin` and `*.uproject` alongside `*.ush`, `*.usf`, and `*.ini`.
- `lm_qgrepSearchText` defaults to literal text search. Top-level unescaped `|` means literal OR, only a whole branch wrapped by outer double quotes keeps `|` literal, and unquoted `\|` also keeps `|` literal.
- Literal branch whitespace is preserved exactly. `A | B` means searching for `A ` or ` B`, not `A` or `B`.
- Whitespace-only branches between two pipe separators are discarded. `A| |B` behaves like `A|B`.
- Outer double quotes only have special meaning when they wrap the whole branch exactly. Otherwise `"` is treated as a normal character, so `"A|B` means searching for `"A` or `B`, and ` "A|B" ` does not use quote syntax.
- Only truly empty split branches such as `A||B` fall back to matching the entire raw query as one literal string.
- `beforeContextLines` and `afterContextLines` default to `0`. Values above `50` are clamped, and qgrep search summaries include a `contextRequested: ... (capped to 50)` hint when clamping happens.
- `lm_qgrepSearchText` only supports `querySyntax='literal'` and `querySyntax='regex'`. Text `glob` mode is no longer supported.
- In multi-root workspaces, top-level brace alternatives can mix `WorkspaceName/...` and workspace-relative branches. Unscoped branches apply to all current workspaces, scoped branches stay limited to the selected workspaces, and mixed file-search summaries still show `all initialized workspaces`.
- Text examples: `AvatarCharacter`, `AvatarCharacter|AvatarHealthComponent`, `"AvatarCharacter|AvatarHealthComponent"`, `AvatarCharacter\|AvatarHealthComponent`, `Avatar(Character|HealthComponent)`.
- Scope example: `{GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}`.

### Shared pathScope Notes
- `lm_findTextInFiles.pathScope`, `lm_qgrepSearchText.pathScope`, and `lm_getDiagnostics.pathScope` all use the shared `lm-tools://spec/pathScope` syntax.
- `pathScope` limits workspace file paths before text search or diagnostics filtering runs.
- Use VS Code glob semantics. `*` is not recursive, and `**` is recursive.
- Use brace globs, not bare `|` alternation.
- In mixed top-level brace branches, unscoped branches apply to all current workspaces.
- In `{GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}`, the first two branches are scoped, `Config/**/*.ini` is root-anchored unscoped, and `**/Source/**/*.{h,cpp}` is any-depth unscoped.
- Common examples: `Script/**/*.as`, `GameWorkspace/Script/**/*.as`, `{GameWorkspace,UE5}/**/*.{h,cpp,as}`, `{GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h}`.
- Invalid or misleading examples: `GameWorkspace|UE5/**/*.as` is invalid; `GameWorkspace/*/*.as` is valid but not recursive.

### Troubleshooting
- `node` is missing: install Node.js, restart VS Code, then retry.
- `Untitled multi-root workspace is not supported`: save it as a real `.code-workspace` file first.

### More Information
See `CHANGELOG.md` for release history.

---

## 中文

### 概览
LM Tools Bridge 是一个 VS Code 扩展,用于通过 MCP 暴露当前 workspace 的工具能力.
外部 MCP 客户端先连接本地 stdio manager,再绑定到目标 VS Code workspace 实例.

当前只支持 Windows.

### 前置依赖
- VS Code
- 系统 `PATH` 上可以直接执行 `node`

如果缺少 Node.js,扩展启动时会弹出提示,可直接选择 `Install with winget` 或 `Download Node.js`.

### 安装与首次启动
1. 在 VS Code 中安装本扩展.
2. 打开目标文件夹或目标 `.code-workspace`.
3. 先让扩展激活一次,这样会把 `stdioManager.js` 同步到 `%LOCALAPPDATA%\lm-tools-bridge\stdioManager.js`.
4. 扩展激活后,MCP server 会自动启动.

### Codex MCP 配置
推荐在 Codex 中这样配置:

```toml
[mcp_servers.lm_tools_bridge]
command = "powershell.exe"
args = [
  "-NoProfile",
  "-Command",
  "node \"$env:LOCALAPPDATA\\lm-tools-bridge\\stdioManager.js\""
]
enabled = true
```

推荐包一层 PowerShell,因为很多 MCP 客户端不会自动展开原始 `args` 里的环境变量.

### Codex Skill
为了获得更好的 Codex app 使用体验,建议把本扩展和 `vscode-tools` skill 配合使用.

在 Codex app 中输入下面的命令进行安装:

```text
$skill-installer install https://github.com/jiangxiaoxu/lm-tools-bridge/tree/master/skills/vscode-tools
```

安装后请重启 Codex,以加载新的 skill.

### 基本使用
1. 每个客户端会话启动一个 stdio manager.
2. 调用 `lmToolsBridge.requestWorkspaceMCPServer`.
3. `cwd` 传以下任意一种:
   - 目标项目路径
   - 目标 `.code-workspace` 文件路径
4. 握手成功后,再使用 `tools/list` 里的桥接工具,或者继续调用 `lmToolsBridge.callTool`.

说明:
- 调用桥接 workspace 工具前,必须先握手.
- 握手成功 payload 只暴露 workspace 身份信息(`workspaceFolders`,`workspaceFile`)、`discovery` 和 `guidance`,不再暴露 manager session id 或 workspace transport `host`/`port`.
- 如果目标 VS Code 实例还不存在,握手阶段会先尝试拉起匹配的 VS Code 实例.
- 在 Windows 上,握手会按下面的规则从 `cwd` 解析启动目标:
  - 如果 `cwd` 本身就是 `.code-workspace` 文件,直接使用它
  - 如果 `cwd` 是文件,从它的父目录开始
  - 之后按层级逐级向上查找,每一层都先查 `.code-workspace`,再查 `.vscode`,再查 `.git`
  - 如果所有层级都没有命中,就使用当前目录
- 如果绑定后的 VS Code 实例后续关闭,需要重新握手,不会自动重启.

### Search Notes
- 所有 `pathScope` 字段都共用 `lm-tools://spec/pathScope`. 读取一次后,即可在 `lm_findTextInFiles`、`lm_qgrepSearchText` 和 `lm_getDiagnostics` 之间复用同一套语法.
- 这套共享 `pathScope` 语法支持 `<glob>`、`WorkspaceName/<glob>`、`{WorkspaceA,WorkspaceB}/<glob>`、mixed 顶层 brace branch,以及当前 workspaces 内的 absolute path / glob.
- `lm_qgrepSearchText.pathScope` 和 `lm_qgrepSearchFiles.query` 使用 VS Code glob 语义,包括 brace glob.
- qgrep 自动维护的 Unreal include 规则现在也会索引 `*.uplugin` 和 `*.uproject`,以及原有的 `*.ush`,`*.usf`,`*.ini`.
- `lm_qgrepSearchText` 默认按 literal 文本搜索. 顶层未转义 `|` 表示 literal OR,只有被最外层成对双引号完整包裹的 branch 才会保留字面量 `|`,未引用 branch 中的 `\|` 也表示字面量 `|`.
- literal branch 两侧空格会被严格保留. `A | B` 表示搜索 `A ` 或 ` B`,而不是 `A` 或 `B`.
- 如果两个 `|` 之间只有空白字符,这一段会被直接丢弃,所以 `A| |B` 等价于 `A|B`.
- 只有完整且精确包裹整个 branch 的最外层双引号才有特殊语法意义. 其他场景里的 `"` 都按普通字符处理,所以 `"A|B` 表示搜索 `"A` 或 `B`,而 ` "A|B" ` 也不会走 quote 语法.
- 只有真正空的 branch,例如 `A||B`,才会让 qgrep 退回为把整个原始 query 当成一个 literal 字符串匹配.
- `beforeContextLines` 和 `afterContextLines` 默认是 `0`. 超过 `50` 的输入会被钳制,并且 qgrep search summary 会额外输出 `contextRequested: ... (capped to 50)` 提示.
- `lm_qgrepSearchText` 只支持 `querySyntax='literal'` 和 `querySyntax='regex'`. 文本 `glob` 模式已不再支持.
- 在 multi-root workspace 里,顶层 brace alternation 可以混用 `WorkspaceName/...` 和普通 workspace-relative branch. 不带 workspace 前缀的 branch 会作用于所有当前 workspace,带前缀的 branch 只作用于指定 workspace,而 mixed file search 的 summary 仍显示 `all initialized workspaces`.
- 文本示例: `AvatarCharacter`, `AvatarCharacter|AvatarHealthComponent`, `"AvatarCharacter|AvatarHealthComponent"`, `AvatarCharacter\|AvatarHealthComponent`, `Avatar(Character|HealthComponent)`.
- 范围示例: `{GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}`.

### Shared pathScope Notes
- `lm_findTextInFiles.pathScope`,`lm_qgrepSearchText.pathScope` 和 `lm_getDiagnostics.pathScope` 现在都使用共享的 `lm-tools://spec/pathScope` 语法.
- `pathScope` 会在文本搜索或诊断过滤前先收窄 workspace 文件路径范围.
- 使用 VS Code glob 语义. `*` 不递归,`**` 才递归.
- 不支持裸 `|` alternation,需要改用 brace glob.
- 在 `{GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}` 中,前两个 branch 是 scoped,`Config/**/*.ini` 是从每个 workspace 根开始的 unscoped branch,而 `**/Source/**/*.{h,cpp}` 是 any-depth 的 unscoped branch.
- 常见示例: `Script/**/*.as`,`GameWorkspace/Script/**/*.as`,`{GameWorkspace,UE5}/**/*.{h,cpp,as}`,`{GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h}`,`{GameWorkspace/Script/**/*.as,UE5/Engine/**/Source/**/*.h,Config/**/*.ini,**/Source/**/*.{h,cpp}}`.
- 错误或易误用示例: `GameWorkspace|UE5/**/*.as` 是无效写法; `GameWorkspace/*/*.as` 合法但不是递归匹配.

### 故障排查
- 缺少 `node`: 先安装 Node.js,重启 VS Code 后再试.
- `Untitled multi-root workspace is not supported`: 先把当前多根 workspace 保存成真实 `.code-workspace` 文件.

### 更多信息
版本历史见 `CHANGELOG.md`.
