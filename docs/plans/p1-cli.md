# P1 CLI 完善计划

> 状态：Accepted
>
> 版本：1.0
>
> 最后更新：2026-08-29
>
> 契约基线：[ADR-0002](../decisions/0002-p1-config-artifact-root.md)、[ADR-0003](../decisions/0003-p1-application-service-session.md)、[ADR-0005](../decisions/0005-restore-artifact-config.md)、[contracts.md](../contracts.md) 1.2

## 1. 目标

P1 在已通过验收的 P0 单次 `run` 闭环上补齐日常 CLI 使用体验。完成后，ECHO 应当在没有 WebUI 的情况下支持持久配置、多轮会话、会话恢复和一致的终端交互，并为 P2 提供可复用的应用服务、事件与会话查询边界。

P1 遵循以下原则：

- 保持 CLI-first，不实现 TUI；
- 保持单 Provider，不在会话内切换 Provider；
- 配置层级保持简单，秘密与非秘密配置分离；
- `run`、`chat` 与未来 WebUI 复用同一个 Agent Loop，不复制控制流；
- 所有新增行为由 Fake Provider 和确定性自动化测试覆盖；
- P0 已接受的安全、脱敏、退出码和 stdout/stderr 契约不得退化。

## 2. 范围

P1 分为三个交付单元：

1. P1-1：交互式 Chat；
2. P1-2：配置与模型目录；
3. P1-3：CLI 体验与视觉优化。

Skill、插件、MCP、多智能体和其他扩展能力不属于 P1。WebUI 与可解释性工作台属于 [P2](./p2-webui.md)。P3 暂不规划。

## 3. P1-1：交互式 Chat

### 3.1 命令入口

```powershell
echo-harness chat [--workspace <path>]
echo-harness chat --resume <session-id> [--workspace <path>]
```

- `chat` 创建新 Session，并在其中连续执行多个 Turn；
- `--resume` 恢复同一工作区中的已有 Session，并接受启动摘要 / `/status` 中显示的唯一 SESSION 短 ID；
- 空白、`../`、`..\\` 或其他路径分隔符、非法字符的 `--resume` 值以退出码 2 报告配置错误，不得抛出未分类的存储异常；
- 每个 Turn 继续使用 P0 的 Agent Loop、Context Projector、工具注册表、安全策略和 JSONL 事件存储；
- Provider 在 Chat 进程中固定，Chat 内不支持更换 URL 或 API Key；
- 恢复时若当前 Provider 与会话创建时的 Provider 不一致，应拒绝静默发送历史上下文，并给出可操作的配置错误。事件只保存 `ProviderIdentity`（含不可逆 `EndpointFingerprint`），不保存凭据或原始 URL。

### 3.2 Slash 命令

P1 只提供以下命令：

```text
/help
/status
/model
/model <model-id>
/model refresh
/safety
/safety <mode>
/quit
```

明确不提供 `/model reset`、`/safety reset`、`/provider`、`/new`、`/sessions`、Chat 内 `/resume`、`/clear`、`/diff` 或 `/context`。

Slash 命令只解析本地终端用户在空闲提示符中的输入。模型文本、工具输出、仓库内容和正在执行的 Turn 均不能触发 Slash 命令。

### 3.3 `/status`

`/status` 至少显示：

- Session 短 ID 与 Turn 数；
- 相对或脱敏后的工作区信息；
- 当前 Provider 摘要、模型与安全模式；
- 配置来源：`cli`、`session` 或 `config`；
- 近似上下文预算；
- 最近 Turn 的状态、停止原因与验证摘要。

不得显示 API Key、授权头、未经脱敏的绝对个人路径、模型内部推理或原始敏感参数。

### 3.4 `/model`

- `/model` 显示当前模型和当前 Provider 的候选模型；
- `/model <model-id>` 从下一个 Turn 开始切换当前会话模型；
- `/model refresh` 只在自动发现模式下刷新候选列表；
- 模型切换只改变当前 Session，不写回配置文件；
- 不提供温度、最大输出 token 或 Provider-specific 参数；
- 每次成功切换追加 `model.changed` 事件。

模型选择优先级：

```text
新会话：CLI --model > 配置文件 model
恢复会话：CLI --model > 会话最后模型 > 配置文件 model
```

自动发现失败不得中断已经使用已配置模型运行的 `run` 或 `chat`；它只使候选列表刷新失败。实际模型调用仍负责最终验证模型是否可用以及是否支持所需工具协议。

### 3.5 `/safety`

- `/safety` 显示当前安全模式；
- `/safety safe|balanced|auto` 从下一个 Turn 开始切换；
- 用户可以在三个模式之间自由切换，不设置额外安全上限或二次确认；
- 模式改变不得影响已经开始的 Turn；
- 每次成功切换追加 `safety.changed` 事件。

安全模式选择优先级：

```text
新会话：CLI --safety-mode > 配置文件 safetyMode
恢复会话：CLI --safety-mode > 会话最后模式 > 配置文件 safetyMode
```

“会话最后模式”只指通过 `--resume` 恢复的同一个 Session，不继承任意其他最近 Session。

### 3.6 中断、退出与恢复

- Turn 执行中第一次 `Ctrl+C` 通过现有 AbortSignal 取消 Provider 请求和工具进程，并返回 Chat 提示符；
- Chat 空闲时 `Ctrl+C` 退出；
- `/quit` 正常结束 Chat；
- 已开始的 Turn 必须落入 `completed`、`failed`、`cancelled` 或 `limited`；
- 恢复时从事件事实重建对话、模型与安全模式，不从人类可读终端输出反推状态；
- 损坏、不完整、跨工作区或不兼容版本的 Session 必须安全失败并给出诊断。

## 4. P1-2：配置与模型目录

### 4.1 唯一持久配置

配置固定保存在构建产物根目录：

```text
<artifact-root>/config/echo.config.json
```

程序必须根据自身模块或可执行文件位置解析 `artifact-root`，不能根据 `process.cwd()` 寻找配置。开发与测试入口通过显式依赖注入获得产物根目录，避免依赖个人路径。

配置优先级只保留：

```text
CLI 显式参数 > echo.config.json
```

`ECHO_API_KEY` 是唯一正式支持的秘密环境变量，不参与普通配置合并。P0 的用户配置、项目配置以及 `ECHO_BASE_URL`、`ECHO_MODEL`、`ECHO_SAFETY_MODE` 来源在 P1 中移除；由于项目尚未公开发布，不建立复杂迁移层。

本规划落地时，配置来源已由 [ADR-0002](../decisions/0002-p1-config-artifact-root.md) 取代 [公共契约](../contracts.md) 第 10 节的 P0 定义。[ADR-0005](../decisions/0005-restore-artifact-config.md) 恢复产物根落点，工作区 `.echo/config` 不是配置来源。P1-2A 已使 `loadConfig` 与 `echo-harness run` 执行该规则。`artifact-root` 与 `ECHO_API_KEY` 隔离规则以 ADR-0002 为准。

### 4.2 配置入口

```powershell
echo-harness config
```

该命令提供单一交互流程：

1. 输入并校验 OpenAI-compatible Provider URL；
2. 选择 `discover` 或 `manual` 模型目录；
3. 选择或输入默认模型；
4. 选择默认安全模式；
5. 原子写入固定配置文件。

交互流程在最终确认前只维护内存草稿。任一步收到 `Ctrl+C` 都以取消状态干净退出，不创建或覆盖配置文件；最终写入使用同目录临时文件和原子替换，写入失败时保留旧配置并清理临时文件。

P1 不提供 `config get/set/list/profile` 子命令，也不实现多 Provider Profile。

配置缺失时，`run` 和 `chat` 应返回稳定的配置退出码并提示执行 `echo-harness config`；不得自动创建含真实信息的配置文件。

### 4.3 配置结构

自动发现模式：

```json
{
  "baseUrl": "https://provider.example/v1",
  "model": "example-model",
  "modelCatalog": {
    "source": "discover"
  },
  "safetyMode": "balanced"
}
```

手动模式：

```json
{
  "baseUrl": "https://provider.example/v1",
  "model": "model-a",
  "modelCatalog": {
    "source": "manual",
    "models": ["model-a", "model-b"]
  },
  "safetyMode": "balanced"
}
```

要求：

- 配置文件不得接受 `apiKey`、授权头或 URL 内嵌凭据；
- 未知键产生明确诊断，避免静默拼写错误；
- 手动模式至少包含一个唯一、非空模型 ID，默认模型必须位于列表中；
- 自动模式不持久化完整发现列表，只持久化选中的默认模型；
- P0 已有的非敏感限制字段可继续保留，但不增加额外配置来源。

### 4.4 自动发现

自动发现通过当前 OpenAI-compatible Provider 客户端请求：

```http
GET {baseUrl}/models
Authorization: Bearer ${ECHO_API_KEY}
```

只使用响应中的模型 ID，不推断价格、上下文长度、推理能力或工具能力。列表在当前进程内缓存；`run` 不主动发现模型。`chat` 仅通过可注入的模型目录端口在 `/model` 需要候选项时列出结果，不得自行实现第二套 `GET /models` 发现与缓存。

自动发现必须覆盖鉴权失败、网络失败、无效响应、空列表、重复 ID、取消和超时。错误中不得回显 Key 或 Provider 原始敏感响应。

## 5. P1-3：CLI 体验与视觉优化

P1-3 只改变表现层，不增加 Agent 能力。视觉基线固定为“分组式时间线”：每个 Step 是一个独立视觉单元，工具、审批与结果在 Step 内形成父子层级。P1 不实现 Spinner、原地刷新、折叠式 TUI、Markdown 渲染或另一套终端状态机；输出继续采用可复盘的追加式纯文本渲染。`run` 的 stdout/stderr 与退出码保持 P0。本节是视觉规范；落地后的当前渲染器见 [cli-ux.md](../cli-ux.md)。

### 5.1 信息层级与间距

TTY 且支持 Unicode 时，Step 使用独立标题：

```text
── Step 6 ─────────────────────────────────────────────
```

非 Unicode 环境使用 ASCII 降级：

```text
-- Step 6 ------------------------------------------------
```

间距规则固定为：

- 每个 Step 标题前恰好一个空行，使连续 Turn/Step 可以快速扫描；
- Step 标题与第一条事件之间不再插入空行；
- 同一工具的请求、审批和结果连续显示，不被无关空行拆散；
- 完整视觉分组之间恰好一个空行：`ECHO` 进度与后续工具组之间、相邻工具组之间；
- 最终结果前恰好一个空行，并使用独立标题与摘要块；
- 模型最终答复与 stderr 进度保持既有 stdout/stderr 边界，不用空行改变数据通道语义。

`STEP` 不再作为普通标签行与正文并列。标题只表达 Step 边界，Turn/Session 信息继续使用简洁的 `ECHO` 摘要。

### 5.2 标签列与工具分组

普通事件使用 10 字符语义标签列，并在标签后始终输出一个空格及显式分隔符。不得依赖 `padEnd()` 自身形成间隔，以避免 `APPROVAL`、`CANCELLED` 等长标签与正文粘连。

```text
TOOL       │ run_command
COMMAND    │ node cli.js --help
RESULT     │ OK · exit 0 · 668 ms
```

ASCII 降级只替换分隔符，不改变信息结构：

```text
TOOL       | run_command
COMMAND    | node cli.js --help
RESULT     | OK | exit 0 | 668 ms
```

工具摘要根据类型使用稳定字段名，例如 `COMMAND`、`PATH`、`QUERY` 或 `TARGET`。工具终态必须与请求处于同一分组中：成功或普通失败使用 `RESULT`，策略拒绝使用 `DENIED`，取消使用 `CANCELLED`。默认模式不单独渲染没有新增信息的 `tool.authorized`。

相邻完整分组之间恰好一个空行，例如 `ECHO` 进度之后的第一个工具，以及同一 Step 内的下一个工具：

```text
ECHO       │ Checking the script.

TOOL       │ run_command
COMMAND    │ python test.py
RESULT     │ OK · exit 0 · 268 ms

TOOL       │ run_command
COMMAND    │ python test.py 2
RESULT     │ OK · exit 0 · 200 ms
```

### 5.3 审批块

审批属于当前工具，不作为顶格的独立事件流。默认布局为：

```text
APPROVAL   │ Required
           │ Risk   Executing an unclassified repository script
           │ Scope  once or equivalent operations in this session
           │ Approve [y] once / [s] session / [n] deny › s
APPROVED   │ session
RESULT     │ OK · exit 0 · 668 ms
```

要求：

- `Risk`、`Scope` 和输入提示使用悬挂缩进，与正文起点对齐；
- 选择顺序与键位在同一行表达，默认拒绝语义保持不变；
- 用户输入后追加 `APPROVED` 或 `DENIED`，不原地擦除历史输出；
- 用户拒绝时 `approval.denied` 与随后同因的 `tool.denied` 只输出一次 `DENIED`；
- 已由会话授权且无需再次询问的工具不输出冗余批准信息；
- 非交互模式继续沿用 P0 的确定性拒绝/授权规则，不伪造交互输入。

### 5.4 宽度感知与换行

渲染器根据目标输出流的终端列数计算可见宽度；ANSI 转义序列不计入宽度，CJK 与其他宽字符按终端显示宽度处理。长内容续行必须对齐正文列：

```text
COMMAND    │ Get-ChildItem -Force | Select-Object Name,
           │ Length, LastWriteTime
```

当终端过窄，无法同时容纳标签列和可读正文时，自动切换为堆叠布局：

```text
TOOL run_command
  Command:
    Get-ChildItem -Force |
    Select-Object Name, Length
```

换行不得移除既有截断标记、原始长度、相对路径或脱敏结果。`--verbose` 可以增加字段与 bounded 详情，但不改变事件顺序和层级。

### 5.5 最终结果

最终结果必须与最后一个 Step 分离，并优先回答整体状态、原因与验证证据。成功示例：

```text
── Run completed ───────────────────────────────────────
STEPS      │ 8
TOOLS      │ 6
CHANGES    │ 2 files
VERIFIED   │ pnpm test · exit 0 · 4.8 s
```

失败示例：

```text
── Run failed ──────────────────────────────────────────
REASON     │ policy_denied
STEPS      │ 11
TOOLS      │ 11
CHANGES    │ none
LAST CHECK │ Get-Content cli.js -TotalCount 30 · exit 0
DETAIL     │ One or more operations were denied.
           │ Encoded execution or broad destructive effects are blocked.
```

整体 Turn 失败时不得使用 `VERIFIED` 暗示任务成功。若只存在此前一次成功的检查，使用 `LAST CHECK`；没有执行验证时明确显示 `NOT VERIFIED`。工具成功、验证成功和 Turn 成功仍是三个不同结论。

### 5.6 颜色与能力降级

颜色只作用于标签、标题或状态词，不染整行正文：

- Step：蓝色并加粗；
- Tool：青色；
- Approval：黄色；
- Approved、OK、Completed：绿色；
- Denied、Fail：红色；
- 命令、路径、模型文本和说明：终端默认前景色。

语义不得依赖颜色。TTY 可使用 Unicode 分隔线与 `│`；非 TTY、Unicode 不可用或稳定日志场景使用结构相同的 ASCII 版本。`--no-color` 只移除 ANSI 颜色，不删除状态词、缩进、分隔或错误原因。

### 5.7 Chat 启动摘要、状态条与输入

Chat 使用“启动摘要 + 提示符状态条 + `/status` 详情”三层信息结构。P1 不实现固定在屏幕底部的状态栏或带动态边框的输入框；这些形态需要光标控制和重绘，属于 TUI 边界，也会破坏追加式日志、终端缩放和重定向行为。

#### 5.7.1 启动摘要

新建或恢复 Chat 时只显示一次 Session 摘要：

```text
ECHO Harness · chat

WORKSPACE   │ ECHOCodingHarness
SESSION     │ a13f09c2
PROVIDER    │ OpenAI-compatible
MODEL       │ deepseek-chat
SAFETY      │ balanced

Type /help for commands · Ctrl+C cancels a running turn
```

恢复会话使用 `ECHO Harness · resumed session`。摘要显示工作区安全名称、Session 短 ID、Provider 类型、模型和安全模式；不得显示个人绝对路径、完整私有 Provider URL、API Key 或低频运行限制。`--resume` 必须能用该短 ID 唯一恢复同一工作区会话。Provider 与 Key 的详细状态通过 `/status` 查看。

#### 5.7.2 提示符状态条

每次进入空闲输入状态时，先空一行，再显示一行低亮度状态，再显示输入提示符。上一段 Slash 反馈、Turn 摘要或启动摘要与状态条之间恰好一个空行；状态条与 `YOU` 提示符之间不再空行。

```text
ECHOCodingHarness · deepseek-chat · balanced
YOU › _
```

状态条固定按以下顺序显示：

```text
workspace · model · safety
```

不重复显示 Session ID、Provider、Turn 数或最近状态。Workspace 使用安全名称而非绝对路径；长 Workspace 或模型 ID 按第 5.4 节规则截断或换行。

Context 在正常范围内不占据状态条。达到可用输入预算的 70% 后追加 `context <n>%`，达到 90% 后使用警告色，但百分比文本本身仍表达语义：

```text
ECHOCodingHarness · deepseek-chat · balanced · context 78%
YOU › _
```

#### 5.7.3 输入语义

- Unicode TTY 使用 `YOU ›`，ASCII 降级使用 `YOU >`；
- 用户输入行直接保留为终端会话记录，提交后不重复渲染第二份 `YOU` 消息；
- 提交后与 Slash 反馈或 Step 时间线之间恰好一个空行；
- Enter 提交非空输入；空输入不创建 Turn，也不重复打印状态条；
- 多行粘贴的识别方式已由 [ADR-0003](../decisions/0003-p1-application-service-session.md) 冻结为 bracketed paste；一次粘贴不得被拆成多个 Turn，也不得触发 Slash 命令，并必须由 PTY 或输入适配器测试覆盖；
- Chat 输入只在 Agent 空闲时生效，运行中由 `Ctrl+C` 负责取消当前 Turn；
- Chat 输入与审批输入使用不同标签，避免把审批选择误认为模型消息。

审批继续使用：

```text
APPROVAL   │ Required
           │ Approve [y] once / [s] session / [n] deny › _
```

#### 5.7.4 模型回复与 Turn 节奏

Chat 中的模型最终回复使用 `ECHO` 角色标签，并在其后显示独立 Turn 摘要：

```text
ECHO       │ 已修复参数解析问题，并完成测试验证。

── Turn completed ──────────────────────────────────────
STEPS      │ 4
TOOLS      │ 4
CHANGES    │ 1 file
VERIFIED   │ pnpm test · exit 0 · 4.8 s

ECHOCodingHarness · deepseek-chat · balanced
YOU › _
```

因此一个 Chat Turn 的稳定视觉顺序为：

```text
YOU input
  -> blank line
  -> Step timeline
  -> ECHO final response
  -> Turn summary
  -> blank line
  -> status strip and next YOU prompt
```

`run` 继续保持最终模型答复写入 stdout、进度与摘要写入 stderr 的 P0 契约；Chat 的角色标签属于交互式表现适配，不得改变核心事件或让终端文本成为状态来源。

#### 5.7.5 Slash 命令反馈

Slash 命令不创建 Step。成功切换模型或安全模式后，只输出改变后的值和生效时机，再由下一条状态条确认当前状态：

```text
ECHOCodingHarness · deepseek-chat · balanced
YOU › /model deepseek-reasoner

MODEL      │ deepseek-reasoner
           │ Applies to the next turn.

ECHOCodingHarness · deepseek-reasoner · balanced
YOU › _
```

```text
ECHOCodingHarness · deepseek-reasoner · balanced
YOU › /safety auto

SAFETY     │ auto
           │ Applies to the next turn.

ECHOCodingHarness · deepseek-reasoner · auto
YOU › _
```

命令失败使用同一分组结构给出原因，不修改状态条中的当前值。

#### 5.7.6 `/status`

低频信息统一由 `/status` 展示：

```text
YOU › /status

── Session status ──────────────────────────────────────
WORKSPACE   │ ECHOCodingHarness
SESSION     │ a13f09c2
PROVIDER    │ OpenAI-compatible
MODEL       │ deepseek-reasoner · session
SAFETY      │ auto · session
TURNS       │ 6
CONTEXT     │ ~18,400 / 28,000 tokens · 66%
LAST TURN   │ completed · 5 steps · 7 tools
LAST CHECK  │ pnpm test · exit 0
API KEY     │ configured

ECHOCodingHarness · deepseek-reasoner · auto
YOU › _
```

模型和安全模式在值后显示 `cli`、`session` 或 `config` 来源。API Key 只显示 `configured` 或 `missing`；Provider 默认显示通用类型，只有安全且确有诊断需要时才显示经过脱敏的 host。

#### 5.7.7 完整 Chat 示例

```text
ECHO Harness · chat

WORKSPACE   │ ECHOCodingHarness
SESSION     │ a13f09c2
PROVIDER    │ OpenAI-compatible
MODEL       │ deepseek-chat
SAFETY      │ balanced

Type /help for commands · Ctrl+C cancels a running turn

ECHOCodingHarness · deepseek-chat · balanced
YOU › 检查当前测试失败并修复问题。

── Step 1 ─────────────────────────────────────────────
TOOL       │ run_command
COMMAND    │ pnpm test
RESULT     │ FAIL · exit 1 · 3.2 s

── Step 2 ─────────────────────────────────────────────
TOOL       │ search_text
QUERY      │ "parseArguments" in src
RESULT     │ 3 matches

── Step 3 ─────────────────────────────────────────────
TOOL       │ apply_patch
TARGET     │ src/cli/parse-arguments.ts
APPROVAL   │ Required
           │ Risk   Modifying a workspace file
           │ Scope  once or equivalent operations in this session
           │ Approve [y] once / [s] session / [n] deny › y
APPROVED   │ once
RESULT     │ OK · 1 file changed

── Step 4 ─────────────────────────────────────────────
TOOL       │ run_command
COMMAND    │ pnpm test
RESULT     │ OK · exit 0 · 4.8 s

ECHO       │ 已修复参数解析问题，并完成测试验证。

── Turn completed ──────────────────────────────────────
STEPS      │ 4
TOOLS      │ 4
CHANGES    │ 1 file
VERIFIED   │ pnpm test · exit 0 · 4.8 s

ECHOCodingHarness · deepseek-chat · balanced
YOU › _
```

### 5.8 `run` 完整示例

```text
ECHO       │ Inspect the CLI behavior.

── Step 6 ─────────────────────────────────────────────
TOOL       │ run_command
COMMAND    │ node cli.js --help
APPROVAL   │ Required
           │ Risk   Executing an unclassified repository script
           │ Scope  once or equivalent operations in this session
           │ Approve [y] once / [s] session / [n] deny › s
APPROVED   │ session
RESULT     │ OK · exit 0 · 668 ms

── Step 7 ─────────────────────────────────────────────
TOOL       │ run_command
COMMAND    │ node cli.js run --help
APPROVAL   │ Required
           │ Risk   Executing an unclassified repository script
           │ Scope  once or equivalent operations in this session
           │ Approve [y] once / [s] session / [n] deny › s
APPROVED   │ session
RESULT     │ OK · exit 0 · 350 ms

── Step 8 ─────────────────────────────────────────────
TOOL       │ run_command
COMMAND    │ Get-ChildItem -Force | Select-Object Name,
           │ Length, LastWriteTime
APPROVAL   │ Required
           │ Risk   Compound commands and pipelines require confirmation
           │ Scope  once or equivalent operations in this session
           │ Approve [y] once / [s] session / [n] deny › s
APPROVED   │ session
RESULT     │ OK · exit 0 · 266 ms

── Step 11 ────────────────────────────────────────────
TOOL       │ run_command
COMMAND    │ node -e "import('./index.js').then(...)"
DENIED     │ Hard policy
           │ Encoded execution or broad destructive effects are blocked.

── Run failed ─────────────────────────────────────────
REASON     │ policy_denied
STEPS      │ 11
TOOLS      │ 11
CHANGES    │ none
LAST CHECK │ Get-Content cli.js -TotalCount 30 · exit 0
DETAIL     │ One or more operations were denied.
```

### 5.9 不变约束

实现上述视觉基线时仍必须满足：

- `run` 与 `chat` 使用一致的状态语言；
- 用户输入、模型输出、工具、审批、警告、失败、取消和完成易于区分；
- 默认输出克制，详细信息由明确操作或 verbose 能力展示；
- 长命令、长路径、diff 和输出有稳定截断规则；
- 流式模型文本不得破坏提示符、审批或后续日志布局；
- Windows Terminal、传统 PowerShell、TTY、非 TTY、重定向和 `--no-color` 均可读；
- 语义不依赖颜色、emoji、特殊字体或动画；
- stdout、stderr、退出码与现有自动化契约保持稳定；
- 渲染器继续只消费结构化事件，不从终端文本驱动状态。

## 6. P2 准备边界

P1 必须交付以下可复用内部边界，但不启动 HTTP 服务或 React 前端：

```text
CLI input
   |
   v
Application service
   |
   v
Agent Loop ------> Session repository
   |
   +-------------> EchoEvent stream ------> CLI renderer
```

### 6.1 应用服务

`run` 和 `chat` 通过同一应用服务创建、恢复、执行和取消 Turn。审批响应必须绑定 `turnId`、`toolCallId` 与 `approvalKey`，并区分 accepted 与 duplicate/expired/not_pending。CLI 参数解析、readline 和渲染器不得持有 Agent 决策逻辑。

### 6.2 会话运行时状态

至少公开可测试的当前模型与当前安全模式。Agent Loop 在每个 Turn 和每次策略判断时读取当前有效状态，不把可变值永久冻结在 CLI 初始化代码中。

### 6.3 会话查询

Session 存储至少支持创建、列出、读取、恢复以及按 Turn/Step 整理事件。P2 直接调用该接口，不解析 JSONL 文本细节或 CLI 输出。

### 6.4 可解释事件

P1 负责记录未来 WebUI 所需的事实：

- Session、Turn、Step 标识与时间；
- 模型与安全模式变化；
- Context 投影版本、预算、估算量和裁剪原因摘要；
- 工具请求、策略决定、审批和执行终态；
- Policy rule ID 与用户可读原因；
- 命令耗时、退出码和截断状态；
- Turn 终态、停止原因和可引用的验证结果。

事件不得保存模型内部思维链、秘密、未经脱敏的个人路径或原始敏感参数。

## 7. 实施顺序

1. P1-0 已用 ADR-0002/ADR-0003 冻结配置来源、Chat 状态恢复、应用服务、事件版本和粘贴边界；
2. P1-2A / P1-2B 实现固定产物配置和模型发现；
3. P1-1A / P1-1B 实现应用服务、Chat Session、Slash 命令、中断和恢复；
4. 补齐会话查询、Context 摘要和 Policy Explain 事实；
5. 按第 5 节已冻结的分组式时间线规范实现 CLI 视觉方案（P1-3）；
6. 运行完整质量门、离线 Eval、演示 smoke 和受控真实 Provider 验收。

## 8. 验收标准

P1 完成必须同时满足：

- P0 `run` 行为、退出码、安全边界和全部测试不退化；
- `config`、新 Chat、恢复 Chat、模型发现、模型切换和安全模式切换均有自动化覆盖；
- `safe`、`balanced`、`auto` 可由终端用户自由切换，模型无法伪造命令；
- `Ctrl+C` 能终止 Provider 请求与 PowerShell 进程树，且不会留下悬空事件；
- 从非产物工作目录启动时仍读取正确配置；
- Key 不进入配置、事件、工具子进程、终端或测试快照；
- Session 恢复具有工作区、Provider、版本和损坏输入保护；
- CLI 在 Windows TTY、非 TTY、无颜色和重定向场景具有确定性测试；
- `pnpm check`、离线 Eval、演示 smoke、秘密扫描和身份扫描全部通过；
- 真实 Provider 验收继续只在本地显式运行，不进入 CI。

第 8 节已由 P1 最终集成验收用自动化证据闭合：`P1_TEST_MATRIX` 不再含 `pending:` 行；`pnpm check`、`pnpm eval:offline`、`pnpm smoke:demo`、`pnpm smoke:artifact`、秘密/身份扫描与 Windows CI 为可复现门禁。已知限制见第 9 节与 [testing.md](../testing.md)。

## 9. 主要风险

- Chat 使 Agent Loop 从一次调用扩展为长期状态，取消与事件恢复容易产生悬空状态；
- Provider `/models` 并非所有 OpenAI-compatible 服务都完整实现，发现结果不能成为执行已配置模型的硬依赖；
- 固定产物配置便于演示，但不适合只读安装目录或多用户系统；这是当前项目主动接受的简化边界；
- CLI 美化可能破坏管道和快照，所有视觉改动必须保留非交互契约；
- 若 P1 未先稳定事件与应用服务，P2 会被迫复制 CLI 逻辑或返工 Session 存储。
