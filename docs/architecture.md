# ECHO Harness 架构设计

> 状态：Accepted
>
> 版本：1.2
>
> 最后更新：2026-08-29

## 1. 文档目的

本文定义 ECHO Harness 首个可交付版本的架构边界与关键约束。P0 实现、测试和受控真实 Provider 验收已与 1.0 边界对齐。P1-0 冻结的配置、应用服务与事件边界见
[ADR-0002](./decisions/0002-p1-config-artifact-root.md)、[ADR-0003](./decisions/0003-p1-application-service-session.md)
和 [contracts.md](./contracts.md) 1.2。后续实现若与本文冲突，应先更新相应 ADR，再修改本文。

ECHO 表示：

- **Execution**：在明确边界内读取、修改并验证代码；
- **Context**：把会话事件投影为有限且有效的模型上下文；
- **Harness**：承载模型、工具、安全策略和状态管理；
- **Orchestration**：驱动“推理—行动—观察—完成”的循环。

项目定位：**A lightweight, local-first autonomous coding agent built from scratch.**

## 2. 目标与非目标

### 2.1 首个版本目标（P0）

- 提供可运行的 `echo-harness` CLI；
- 通过 OpenAI-compatible API 与一个真实模型服务完成端到端调用；
- 自主完成模型请求、工具调用、结果反馈和终止判断；
- 提供文件浏览、文本搜索、文件读取、文件写入、补丁应用和命令执行能力；
- 将所有操作限制在指定工作区，并对高风险操作执行统一策略；
- 保存经过脱敏的 JSONL 会话事件，支持诊断和演示复盘；
- 在 Windows、Node.js 22 和 PowerShell 环境下稳定运行；
- 使用单元测试、集成测试、演示烟测和 CI 验证质量。

### 2.2 次级目标（P1）

- 增加交互式 `chat`、固定产物配置 `config` 和单 Provider 模型目录；
- 抽出 `run`/`chat` 共用的应用服务、可恢复 Session 与 Session 查询；
- 按冻结的分组式时间线改进 CLI 展示，不引入 TUI。

P1 不实现 WebUI。配置查找不得使用 `process.cwd()`；唯一持久文件为 `<artifact-root>/config/echo.config.json`。`ECHO_API_KEY` 仍是唯一秘密环境变量。

### 2.3 非目标（P2 或明确排除）

- 首版不提供 Web UI、域名展示页或多客户端服务；
- 不实现多智能体、插件市场、MCP、LSP 或向量数据库；
- 不追求完整 IDE、容器沙箱或操作系统级安全隔离；
- 不封装现有 coding agent，也不使用 Agent 框架或其托管工具执行能力；
- 不承诺所有 OpenAI-compatible 服务行为完全一致，只保证经验证的目标服务与配置方式。

## 3. 架构原则

1. **自主循环归本项目所有**：ECHO 自行维护步骤、历史、工具调度、错误处理和终止条件。
2. **传输层不拥有控制权**：模型客户端仅负责 HTTP/SSE 与协议转换，不执行工具、不管理循环。
3. **事件先于界面**：CLI、日志和未来 UI 消费同一事件模型；CLI 通过独立 `EventRenderer` 将事件映射为输出，核心逻辑不依赖表现层。
4. **策略集中执行**：路径、命令、审批、超时、输出限制都通过统一执行管线生效。
5. **状态可解释**：每次模型调用和工具调用都有明确的开始、结果或错误状态。
6. **Windows 是一等平台**：路径语义、PowerShell 调用、进程树终止与编码问题必须被测试。
7. **范围小而完整**：优先交付可验证的闭环，不以未经验证的功能数量换取表面完整度。

## 4. 系统上下文

```text
User / Demo Script
        |
        v
  echo-harness CLI  (parser, paste adapter, renderer)
        |
        v
  Application service
        |
        v
  Agent Orchestrator <------ Session repository (JSONL)
     |      |      |
     |      |      +------> Context Projector
     |      |
     |      +-------------> Tool Runtime -> Safety Policy -> Workspace / PowerShell
     |
     +--------------------> Model Provider -> OpenAI-compatible API
```

P1-1A 已将 `run` 接到应用服务；核心层不直接依赖终端渲染。所有用户可见进度先表示为领域事件，再由 CLI 渲染。

## 5. 模块划分

### 5.1 Execution

负责本地能力与副作用：

- 工具注册与输入校验；
- 路径规范化、工作区边界检查；
- 文件读写与补丁应用；
- PowerShell 子进程启动、超时和终止；
- 输出截断、结果归一化和变更摘要。

任何文件或命令副作用都不得绕过此层。

### 5.2 Context

负责将会话事实转换为模型可消费的请求：

- 保存追加式事件；
- 保留系统约束、当前目标和最近步骤；
- 保留先前 Turn 的用户目标，使恢复会话与多轮 Chat 能按时间重建对话；
- 裁剪陈旧且体积大的命令输出；
- 生成稳定的状态摘要；
- 控制近似上下文预算。

首版使用字符数或近似 token 估算，不引入向量检索。原始会话事件与发送给模型的上下文投影分离。

### 5.3 Harness

负责连接模型、工具、安全与会话：

- Provider 抽象与 OpenAI-compatible 实现；
- 工具目录与 JSON Schema；
- 安全策略决策；
- 会话存储；
- 错误分类、重试和取消信号。

### 5.4 Orchestration

负责 Agent Loop：

- 创建 Turn 与 Step；
- 请求模型并消费流式事件；
- 顺序执行工具调用；
- 将工具结果反馈给模型；
- 判断完成、失败、取消、步数上限与重复调用；
- 生成最终 `AgentResult`。

### 5.5 Application service

P1 增加应用服务，作为 CLI 与未来 WebUI 的唯一编排入口：创建/恢复 Session、执行与取消 Turn、提交绑定 Turn/`toolCallId`/`approvalKey` 的审批并返回 accepted 或 duplicate/expired/not_pending、读写当前模型和安全模式、按 Turn/Step 查询事件。它不渲染终端，也不解析人类可读输出。P1-1A 已实现该服务并让 `run` 调用它。P1-2A 已实现配置加载；P1-2B 已实现单 Provider 模型目录与进程内缓存。P1-1B 已实现 Chat 输入适配器、Slash 与 `--resume`；Chat 通过可注入的模型目录端口列出 `/model` 候选项，不自行实现第二套 `GET /models` 发现。

## 6. Turn、Step 与 Agent Loop

### 6.1 生命周期

- **Session**：同一工作区内的一段可复盘会话；
- **Turn**：一个用户目标及其完整处理过程；
- **Step**：一次模型响应以及由它产生的零个或多个工具调用。

### 6.2 状态流

```text
Turn started
  -> build context
  -> request model
  -> model text only -------------------------> completed
  -> tool calls
       -> validate
       -> authorize
       -> execute sequentially
       -> append terminal tool results
       -> build next context
       -> request model again
  -> completed | failed | cancelled | limited
```

首版工具调用按模型给出的顺序串行执行，以获得确定性结果并降低写入冲突。模型返回工具调用时，即使响应的 `finish_reason` 语义不一致，也以实际工具调用内容为准继续循环。

Orchestrator 在任何 `tool.requested` 或工具执行前验证本次响应内及整个 Session 内的
tool-call ID：ID 必须非空且不可重用。违反该条件属于不可恢复的 `provider_protocol`
错误，不进入工具管线。

### 6.3 终止条件

Turn 在以下任一条件满足时终止：

- 模型给出不含工具调用的最终答复；
- 达到最大 Step 数；
- 同一工具与等价参数重复达到阈值；
- 出现不可恢复的 Provider、策略或执行错误；
- 用户取消或进程收到取消信号；
- 安全策略拒绝继续且不存在可恢复路径。

所有已开始的工具调用必须落到 `completed`、`failed`、`denied` 或 `cancelled` 之一，不允许悬空。

## 7. Provider 数据流

Provider 接收规范化的模型请求，并产生规范化流事件：

1. Context Projector 构建消息、工具定义与模型参数；
2. OpenAI-compatible Provider 将其映射为 API 请求；
3. Provider 把文本增量、工具参数增量、完成信息和错误转换为 ECHO 事件；
4. Orchestrator 聚合完整模型输出；
5. 工具调度权始终由 Orchestrator 持有。

首版可使用官方 `openai` npm 包处理协议与流，但不使用任何 Agent SDK、Agent 框架或托管代码执行功能。

模型目录是独立于 completion 流的只读发现路径。`GET {baseUrl}/models` 只产生模型 ID，缓存在当前进程，不进入 Agent Loop。`run` 不发现模型；Chat 仅在 `/model` 或 `/model refresh` 时调用 `listModelCandidates` / `ProcessModelCatalog`。发现失败仍允许使用已配置模型；手动目录下的 `/model refresh` 必须失败并说明仅 `discover` 可刷新。P1-2B 实现该边界。

## 8. 工具执行管线

每个工具调用经过同一管线：

```text
registered?
  -> schema validation
  -> semantic normalization
  -> safety decision (allow / ask / deny)
  -> pre-execution event
  -> execute with timeout and cancellation
  -> normalize bounded result
  -> post-execution event
```

首版工具集：

- `list_files`
- `search_text`
- `read_file`
- `write_file`
- `apply_patch`
- `run_command`

`ToolResult` 是结构化结果，不依赖解析人类可读终端文本。CLI 可以额外渲染摘要和 diff，但模型接收的关键结果必须能从事件中重建。

## 9. 会话事件与状态投影

`.echo/sessions/<session-id>.jsonl` 保存脱敏后的追加式事件。事件是诊断与复盘的事实记录，内存状态由事件顺序投影得到。

事件至少覆盖：

- Session、Turn、Step 的开始与结束；
- 模型请求开始、文本增量、聚合后的原始工具调用、模型完成和模型错误；
- 工具调用状态迁移；
- 策略决策、审批请求与用户审批结果；
- 上下文裁剪、限制触发与取消；
- 最终结果。

日志文件默认加入 `.gitignore`，不得包含 API Key、授权头或完整敏感环境变量。

若事件追加在 `tool.requested` 之后失败，Orchestrator 在存储恢复可读写时以已持久化事件为
事实来源做 best-effort 补偿：只为仍悬空的调用追加一个 `tool.failed`，并追加一个
`turn.failed`。补偿前检查既有工具与 Turn 终态；对于“实际已写入但调用方收到错误”的
歧义结果不得盲目重试，从而避免重复终态。

## 10. 上下文策略

Context Projector 按优先级构建上下文：

1. 不可省略的系统与安全约束；
2. 当前用户目标；
3. 当前工作区和运行配置摘要；
4. 最近的模型与工具事件；
5. 较早步骤的压缩摘要。

大体积工具输出应保留头尾、截断标记、原始长度和可定位信息。首版不要求用模型生成长期摘要；确定性投影足以完成基础闭环。

## 11. Windows 执行模型

- 工作区根路径在启动时解析为绝对规范路径；
- 工具输入路径相对工作区解析，并在执行前再次校验；
- 路径比较遵循 Windows 大小写不敏感语义；
- PowerShell 以非交互方式启动，不加载用户 Profile；使用 `-InputFormat Text` 并立即关闭 stdin，避免无控制台会话中的 CLIXML 等待；管道重定向时关闭进度输出，避免宿主在无控制台环境下阻塞；
- 子进程使用显式工作目录和净化后的环境变量；`PSModulePath` 按 `SystemRoot`/`WINDIR`（大小写不敏感）构造，仅指向系统 `WindowsPowerShell\v1.0\Modules`；
- 超时或取消时终止完整进程树，而不只终止父进程；
- stdout 与 stderr 分开采集、限长，并保留退出码和耗时。

更完整的威胁模型见 [security.md](./security.md)。

## 12. 错误、重试与取消

- Provider 的瞬时网络错误和限流错误可进行有界退避重试；
- 无效请求、鉴权失败和模型不支持工具调用不盲目重试；
- 工具输入无效应作为结构化结果反馈模型，允许其修正；
- 路径越界和硬拒绝不得通过重试或修改提示绕过；
- 取消信号向 Provider 流、工具执行和事件存储传播；
- 任何异常最终映射到稳定的错误类别与 CLI 退出码。

精确契约见 [contracts.md](./contracts.md)。

## 13. CLI 边界

命令优先级：

1. `echo-harness run <goal>`：在指定工作区完成单次目标；
2. `echo-harness chat`：P1 多轮交互；通过应用服务复用同一 Agent Loop；
3. `echo-harness config`：P1 唯一配置向导，写入 `<artifact-root>/config/echo.config.json`。

CLI 负责参数解析、bracketed paste、交互审批、事件渲染和退出码，不包含 Agent 决策逻辑。`EventRenderer` 只消费 `EchoEvent` 与最终 `AgentResult`，不得执行工具、改变会话状态或从终端文本反向推断状态。默认情况下，`run` 的执行进度与诊断写入 stderr，最终面向用户的结果写入 stdout；CI 和演示烟测必须可以通过非交互参数运行。

P1-2A 已使 `run` 读取 `<artifact-root>/config/echo.config.json`。P1-2B 已使模型发现独立于 `run`：CLI `--model` 只覆盖本次运行的模型名，不查询 `/models`。P1-3 只改变表现层：分组式时间线、宽度感知换行和 Chat 输入表面，不得改变事件、退出码或应用服务语义。

具体视觉语义见 [cli-ux.md](./cli-ux.md)（P0）与 [p1-cli.md](./plans/p1-cli.md) 第 5 节（P1 分组时间线）。

## 14. 测试边界

- Provider 使用 Fake Provider 验证确定性循环；
- 工具在临时工作区中进行单元与集成测试；
- 安全测试覆盖路径穿越、工作区外路径、危险命令和密钥泄露；
- Windows CI 覆盖 lint、typecheck、test、build、demo smoke 与非产物目录产物 smoke；
- CI 不调用真实付费模型 API。

具体命令、离线 Eval、覆盖矩阵和 CI 边界见 [testing.md](./testing.md)。

## 15. 未来扩展边界

若主体完成后增加本地服务或 React 页面，它们只能依赖公开的事件和命令契约，不得把 UI 状态反向侵入 Agent Loop。任何本地 HTTP 服务、会话数据库或远程展示页都需单独 ADR，不属于当前承诺。

## 16. 独立实现与原创边界

ECHO 可以借鉴公开项目中通用的软件设计思想，例如显式循环、统一工具管线、事件驱动状态和重复调用保护，但：

- 不复制 DeepSeek Harness、OpenCode 或其他 coding agent 的源代码；
- 不复刻其私有接口、目录结构或框架组合；
- 不把第三方 Agent Loop、工具调度或上下文管理包装成本项目能力；
- 所有核心控制流、工具实现、安全策略和事件模型均在本仓库独立完成并测试。

## 17. 实现状态与剩余验证

P0 的 Provider、Context、文件/命令工具、安全策略、Agent Loop、JSONL 事件存储和
`echo-harness run` 已按 1.0 边界实现。P1-0 已冻结 1.1 契约、ADR 与测试矩阵。P1-2A 已实现
artifact-root 解析、严格配置校验、`echo-harness config` 与 `run` 对新配置规则的加载。P1-2B 已实现
`GET /models` 发现、进程内缓存，以及发现失败不阻断已配置模型。P1-1A 已抽出
`ApplicationService` 与 Session 查询，并把 `run` 接到该服务。P1-1B 已实现 `echo-harness chat`、恢复、Slash、Ctrl+C 与 bracketed paste；默认 `/model` 目录实现为 P1-2B 的 `ProcessModelCatalog`，Chat 仍只通过端口消费、不复制第二套发现。P1-3 已实现分组式时间线与 Chat 输入表现层。P1 集成验收已把第 8 节规划标准落到可复现证据，不启动 P2。

当前目录以 `src/provider/`、`src/context/`、
`src/tools/`、`src/security/`、`src/agent/`、`src/session/` 和 `src/cli/` 分隔职责；CLI
只通过公开事件和 `AgentResult` 观察循环。P1 类型位于 `src/contracts/application.ts`、
`src/contracts/config.ts`、`src/contracts/model.ts` 与 `src/contracts/chat-input.ts`。

已由自动化测试固定的默认限制包括 24 个 Step、单工具 120 秒、单结果 20,000 字符、
32,000 近似 token 上下文（其中预留 4,000 输出 token），以及同一规范化工具调用第三次
出现时终止。P1-1A 已支持从事件恢复 Session 查询、Provider 身份校验和悬空 Turn 补偿；P1-1B 已把
`chat` 恢复、Slash 与粘贴适配器接到同一应用服务。固定失败测试故事已在一个受控 OpenAI-compatible
服务上连续完成 3 次；真实 Provider 兼容性验证保持为显式本地验收，不进入 CI。
