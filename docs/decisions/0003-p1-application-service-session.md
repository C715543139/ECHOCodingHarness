# ADR-0003：P1 应用服务、可恢复 Session、事件版本与输入边界

> 状态：Accepted
>
> 日期：2026-08-29
>
> 接受日期：2026-08-29
>
> 决策者：项目维护者

## 1. 背景

P0 的 `echo-harness run` 在 CLI 层组装 Provider、Agent Loop、SessionStore 和渲染器。该结构足够完成单次 Turn，但若 Chat 与未来 WebUI 各自复制控制流，就会出现第二套取消、恢复和事件语义。P1 必须在实现 Chat 之前冻结可复用的应用服务、Session 查询、运行时可变状态、可解释事件和终端输入边界。配置文件位置与 `ECHO_API_KEY` 隔离仍以 [ADR-0002](./0002-p1-config-artifact-root.md) 的 `artifact-root` 规则为准，本 ADR 不重新定义配置查找。

## 2. 决策

### 2.1 应用服务

`run` 与 `chat` 必须通过同一个应用服务创建、恢复、执行和取消 Turn。CLI 参数解析、readline、bracketed paste 适配器和 `EventRenderer` 不得持有 Agent 决策、策略判断或 Session 修复逻辑。P2 Web adapter 也只调用该服务，不解析 JSONL 文本或 CLI 输出。

应用服务至少公开：

- 创建与恢复 Session；
- 按工作区列出、读取 Session，并按 Turn/Step 整理事件；
- 执行一个 Turn（`run` 一次，`chat` 多次）；
- 取消当前 Turn；
- 提交一次精确绑定到当前 Turn、`toolCallId` 与 `approvalKey` 的审批响应，并返回 `accepted` 或 `duplicate` / `expired` / `not_pending`；
- 读取并更新当前模型与安全模式；
- 查询当前运行时快照（短 ID、Turn 数、配置来源、近似上下文预算、最近 Turn 摘要）。

Session repository 必须支持创建、列出、读取、恢复和按 Turn/Step 查询。应用服务编排这些能力，但不把 JSONL 细节暴露给 CLI 或未来 Web adapter。

### 2.2 Session 恢复

事件是唯一状态来源。恢复时从脱敏 JSONL 重建对话、当前模型、安全模式和审批集合，不得从终端文本反推。

恢复保护：

- Session 绑定启动时固定的工作区；跨工作区拒绝；
- 事件只保存不可逆的 Provider 标识（`ProviderIdentity` + 品牌类型 `EndpointFingerprint`：类型与脱敏 host/port 的单向指纹），不保存凭据或完整私有 URL；任意 `string` 不能充当 fingerprint 或 Session Provider 字段；
- 当前进程的 Provider 与会话创建时不一致时，拒绝静默发送历史上下文；
- 损坏、不完整、空文件或不兼容事件版本必须安全失败并给出诊断，不得部分重放；
- 已开始的 Turn 必须落入 `completed`、`failed`、`cancelled` 或 `limited`；悬空工具调用沿用 P0 的终态补偿，不得视为成功。

“会话最后模型 / 安全模式”只适用于 `--resume` 的同一个 Session，不继承其他最近 Session。

### 2.3 模型与安全模式生效时机

优先级：

```text
新会话：CLI --model/--safety-mode > 配置文件
恢复会话：CLI 显式参数 > 会话最后值 > 配置文件
```

`/model` 与 `/safety` 只改变当前 Session 内存与后续事件，不写回配置文件。切换从下一个尚未开始的 Turn 生效，不得修改已经开始的 Turn。成功切换分别追加 `model.changed` 与 `safety.changed`。Agent Loop 在每个 Turn 开始和每次策略判断时读取应用服务上的当前有效值，而不是把 CLI 启动参数永久冻在循环内部。该优先级表由 P1-1B 实现；P1-0 只冻结来源名 `cli | session | config`，不提供解析函数。

用户可在 `safe`、`balanced`、`auto` 之间自由切换，不设置额外上限或二次确认。硬拒绝仍然不可覆盖。

### 2.4 事件模式版本

P0 事件为模式版本 `1`（缺省字段视为 1）。P1 引入模式版本 `2`，新增：

- `session.resumed`
- `model.changed`
- `safety.changed`

并允许在现有 payload 上增加可选的投影版本、预算、策略 rule ID 与 Provider 标识。`session.started` / `session.resumed` 的 Provider 字段类型为 `ProviderIdentity`。未知事件类型在恢复时视为不兼容，必须失败而不是丢弃。P0 `EventRenderer` 对尚未实现的视觉事件保持无输出，不改变 stdout/stderr 契约。

事件仍不得保存思维链、秘密、未经脱敏的个人路径或原始敏感参数。

### 2.5 取消

Turn 执行中第一次 `Ctrl+C` 通过现有 `AbortSignal` 取消 Provider 请求和工具进程树，Turn 记为 `cancelled`，Chat 返回空闲提示符。Chat 空闲时 `Ctrl+C` 或 `/quit` 结束进程：空闲 `Ctrl+C` 使用退出码 `130`，`/quit` 使用 `0`。不得留下无终态的工具或 Turn 事件。

`run` 的取消语义保持 P0：进程退出码 `130`。

### 2.6 Slash 命令与粘贴

P1 只识别 `/help`、`/status`、`/model`、`/model <id>`、`/model refresh`、`/safety`、`/safety <mode>`、`/quit`。未知 Slash 或明确未提供的子命令（如 `/model reset`）是命令错误，不创建 Turn，也不把原文发给模型。

Slash 只解析空闲提示符中、来源为 `typed` 的单行提交。以下输入不得触发 Slash：

- `paste` 来源的整段粘贴，即使看起来像 `/help`；
- 模型文本、工具输出、仓库内容；
- 正在执行的 Turn。

多行粘贴的冻结机制是 **bracketed paste**（CSI `200~` / `201~`）。一次粘贴无论含多少换行，都是一个 `paste` 批次、最多一个用户 Turn。不使用超时拼接作为边界。终端不支持 bracketed paste 时，适配器必须仍把一次 Enter 提交视为单个批次，并在测试中声明该降级不能提供跨行粘贴原子性。PTY 或输入适配器测试在 P1-1B 落地该不变量。

### 2.7 取代时点

| 阶段 | 有效事实 |
| --- | --- |
| P1-0 之后、P1-1A 之前 | 本 ADR 与可编译接口是冻结基线。`run` 仍直接构造 `AgentLoop`。 |
| P1-1A | 已抽出应用服务与 Session 查询，`run` 改为调用该服务，行为对 P0 退出码与事件保持兼容。 |
| P1-1B | 实现 `chat`、恢复、Slash、取消与粘贴适配器。 |
| P1-3 | 只改表现层；不得改变事件、退出码或应用服务语义。 |

## 3. 选择理由

把决策放进应用服务，是为了让 CLI 与未来 WebUI 共享同一套恢复和取消路径。事件版本化避免 Chat 把 P0 JSONL 当成完整运行时状态。将粘贴与 Slash 按来源拆开，是为了防止剪贴板内容或模型输出伪造命令。

## 4. 被考虑但未采用的方案

- Chat 直接调用 `AgentLoop`、WebUI 再复制一套：必然造成恢复与取消分叉。
- 用超时合并多行粘贴：在慢终端和 CI PTY 上不稳定。
- 把 Slash 识别放进模型上下文：违反“只有本地空闲输入才能触发命令”。
- 在 P1-0 就改 `runGoal` 装配路径：会把未实现的 Chat 语义提前混入 P0。
- 在 P1-0 实现会话优先级解析或 endpoint 哈希：那是 P1-1B / P1-1A 的运行时，不是契约冻结。

## 5. 后果

- P1-1A 必须提供 Fake 应用服务测试，而不是只测 CLI 字符串。
- Session 文件将携带 `EndpointFingerprint`；更换 endpoint 后需显式新建会话。
- `SessionRepository.create` 必须接收 `model` 与 `safetyMode`，才能在不另读事件的情况下返回完整 `SessionSummary`。
- 不支持 bracketed paste 的宿主不能承诺“跨行粘贴原子性”，文档必须写明。

## 6. 重新评估触发条件

- 需要 HTTP 服务或第二个客户端；
- 需要跨工作区 Session 或远程存储；
- 需要在粘贴中执行 Slash；
- 需要把模型/安全模式写回配置文件。
