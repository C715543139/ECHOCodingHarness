# ECHO Harness 核心契约

> 状态：Proposed
>
> 版本：0.1
>
> 最后更新：2026-08-28

## 1. 文档目的

本文定义 ECHO Harness 各核心模块之间的稳定边界。D1-2 对应的可编译共享类型位于
`src/contracts/`；本文仍是语义与不变量的权威来源。实现阶段可以在同步文档、测试和集成方后
细化字段，但不得在各模块内建立相互竞争的私有契约。

文中的“必须”“不得”是强约束，“应”是默认约束，“可以”表示可选能力。

## 2. 命名与标识

所有标识在单个会话中唯一，并使用不含个人信息的随机或时间有序 ID：

```ts
type SessionId = string;
type TurnId = string;
type StepId = string;
type ToolCallId = string;
type EventId = string;
```

- 时间统一存储为 ISO 8601 UTC 字符串；
- 文件路径在工具边界使用相对工作区路径；
- 绝对路径只在 Execution 内部短暂存在，不发送给模型或写入可分享材料；
- 对模型名、Provider 名和工具名使用稳定的小写标识。

## 3. Model Provider

### 3.1 职责

Provider 只负责模型协议适配：请求序列化、HTTP/SSE、流事件解析、取消和错误归一化。

Provider 不得：

- 执行任何工具；
- 决定 Agent Loop 是否继续；
- 直接读取或修改工作区；
- 保存会话状态；
- 绕过 Context Projector 拼接隐式消息。

### 3.2 概念接口

```ts
interface ModelProvider {
  readonly name: string;

  stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamEvent>;
}

interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
}

type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ModelToolCall[] }
  | { role: "tool"; toolCallId: ToolCallId; content: string };

interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ModelToolCall {
  id: ToolCallId;
  name: string;
  arguments: unknown;
}
```

### 3.3 流事件

```ts
type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_delta"; callId: ToolCallId; delta: string }
  | { type: "tool_call"; call: ModelToolCall }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "completed"; finishReason: ModelFinishReason };

type ModelFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "unknown";
```

Provider 必须保证同一调用中的事件顺序稳定。若上游只提供参数增量，Provider 必须在发出完整 `tool_call` 前完成聚合和 JSON 解析。

## 4. 工具契约

### 4.1 定义与执行上下文

```ts
interface ToolDefinition<TInput, TData = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  execute(input: TInput, context: ToolContext): Promise<ToolExecution<TData>>;
}

interface ToolContext {
  sessionId: SessionId;
  turnId: TurnId;
  stepId: StepId;
  toolCallId: ToolCallId;
  workspaceRoot: string;
  signal: AbortSignal;
  limits: ToolLimits;
}

interface ToolLimits {
  timeoutMs: number;
  maxOutputChars: number;
}

type ToolExecution<TData> =
  | { status: "completed"; summary: string; data: TData; truncated: boolean }
  | { status: "failed"; summary: string; error: EchoError; truncated: boolean };
```

工具实现不自行请求用户审批。Orchestrator 必须先取得 PolicyDecision，只有 `allow` 后才能调用 `execute`。

### 4.2 Agent 可见结果

```ts
interface ToolResultMessage {
  toolCallId: ToolCallId;
  toolName: string;
  status: "completed" | "failed" | "denied" | "cancelled";
  summary: string;
  content?: string;
  metadata?: Record<string, string | number | boolean | null>;
  truncated?: boolean;
}
```

- `summary` 必须短小、可理解；
- `content` 必须经过脱敏与输出限制；
- 失败结果必须区分工具业务失败、超时、取消和策略拒绝；
- 不得把异常堆栈、API Key 或完整环境变量直接反馈给模型。

### 4.3 首版工具语义

| 工具 | 输入重点 | 成功结果重点 | 主要副作用 |
| --- | --- | --- | --- |
| `list_files` | 相对目录、可选深度/模式 | 有界相对路径列表 | 无 |
| `search_text` | 查询、相对范围、可选 glob | 文件、行号、匹配片段 | 无 |
| `read_file` | 相对文件、可选范围 | 带行号或范围元数据的文本 | 无 |
| `write_file` | 相对文件、完整内容 | 写入摘要与变更信息 | 创建/覆盖文件 |
| `apply_patch` | 结构化补丁 | 应用结果与 diff 摘要 | 修改文件 |
| `run_command` | 命令、参数或命令文本、超时 | 退出码、stdout、stderr、耗时 | 取决于命令 |

精确 JSON Schema 在工具实现时确定，并由测试验证与模型声明一致。

## 5. 安全策略契约

```ts
type SafetyMode = "safe" | "balanced" | "auto";

type PolicyDecision =
  | { action: "allow"; reason: string }
  | { action: "ask"; reason: string; approvalKey: string }
  | { action: "deny"; reason: string; hard: boolean };

interface PolicyRequest {
  mode: SafetyMode;
  toolName: string;
  normalizedInput: unknown;
  workspaceRoot: string;
  sessionApprovals: ReadonlySet<string>;
}

interface SafetyPolicy {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}
```

强制不变量：

- `deny` 且 `hard: true` 的决策不得被用户批准、模型重试或运行模式覆盖；
- `ask` 必须在实际副作用发生前解决；
- 非交互模式遇到 `ask` 时按显式配置处理，默认拒绝；
- 会话级批准只适用于等价的规范化操作，不得泛化为关闭安全检查；
- 工作区外访问始终为硬拒绝。

## 6. 会话事件

### 6.1 公共信封

```ts
interface EventEnvelope<TType extends string, TPayload> {
  id: EventId;
  sequence: number;
  timestamp: string;
  sessionId: SessionId;
  turnId?: TurnId;
  stepId?: StepId;
  type: TType;
  payload: TPayload;
}
```

`sequence` 在单个 Session 中必须严格递增。事件写入前必须完成脱敏。

### 6.2 事件类别

```ts
type EchoEvent =
  | EventEnvelope<"session.started", SessionStarted>
  | EventEnvelope<"turn.started", TurnStarted>
  | EventEnvelope<"step.started", StepStarted>
  | EventEnvelope<"context.projected", ContextProjected>
  | EventEnvelope<"model.started", ModelStarted>
  | EventEnvelope<"model.text_delta", ModelTextDelta>
  | EventEnvelope<"model.tool_call", ModelToolCallCompleted>
  | EventEnvelope<"model.completed", ModelCompleted>
  | EventEnvelope<"model.failed", OperationFailed>
  | EventEnvelope<"tool.requested", ToolRequested>
  | EventEnvelope<"approval.requested", ApprovalRequested>
  | EventEnvelope<"approval.granted", ApprovalGranted>
  | EventEnvelope<"approval.denied", ApprovalDenied>
  | EventEnvelope<"tool.authorized", ToolAuthorized>
  | EventEnvelope<"tool.started", ToolStarted>
  | EventEnvelope<"tool.completed", ToolCompleted>
  | EventEnvelope<"tool.failed", ToolFailed>
  | EventEnvelope<"tool.denied", ToolDenied>
  | EventEnvelope<"tool.cancelled", ToolCancelled>
  | EventEnvelope<"limit.reached", LimitReached>
  | EventEnvelope<"turn.completed", TurnCompleted>
  | EventEnvelope<"turn.failed", TurnFailed>
  | EventEnvelope<"turn.cancelled", TurnCancelled>;
```

`model.tool_call` 必须保存 Provider 聚合后的完整、Provider 无关工具调用，包括调用 ID、工具名和经脱敏但尚未做语义规范化的参数。`tool.requested` 则记录进入工具管线的输入及其规范化结果；即使后续校验、审批或执行失败，也能区分“模型原始请求”与“ECHO 实际尝试执行的操作”。

同一 Session 中每个 `ModelToolCall.id` 必须是非空且唯一的稳定标识。同一模型响应内重复、
跨 Step 重用或空白 ID 均映射为不可重试的 `provider_protocol` 错误；该响应不得产生
`tool.requested`，也不得执行任何工具。

`approval.requested` 记录待审批操作及风险原因；`approval.granted` 记录本次或当前 Session 的授权范围；`approval.denied` 记录用户拒绝。首批 payload 类型在 `src/contracts/events.ts` 中固化，后续实现只能通过共享契约变更细化。事件的公共字段和状态语义应保持稳定，以便 CLI 与未来界面复用。

### 6.3 工具状态机

```text
tool.requested
  -> tool.denied
  -> approval.requested
       -> approval.denied  -> tool.denied
       -> approval.granted -> tool.authorized
       -> tool.cancelled
  -> tool.authorized
       -> tool.cancelled
       -> tool.started
            -> tool.completed
            -> tool.failed
            -> tool.cancelled
```

`tool.cancelled` 可以发生在等待审批、已授权但尚未启动，或执行过程中。每个 `tool.requested` 必须恰好对应一个工具终态事件：`tool.completed`、`tool.failed`、`tool.denied` 或 `tool.cancelled`。审批事件不是工具终态。进程崩溃后的恢复逻辑如发现悬空调用，应补记 `tool.cancelled` 或恢复诊断事件，不得把它视为成功。

运行中发生 SessionStore 错误时，Orchestrator 应在存储恢复后 best-effort 读取已持久化事实，
只为没有既有终态的 `tool.requested` 补记一个 `tool.failed`，并在没有 Turn 终态时补记一个
`turn.failed`。append 结果不明确时必须先读后判定，不能通过无条件重试制造重复终态。

### 6.4 CLI 渲染契约

```ts
interface RenderCapabilities {
  interactive: boolean;
  color: boolean;
  unicode: boolean;
  verbose: boolean;
}

type OutputChannel = "stdout" | "stderr";

interface RenderChunk {
  channel: OutputChannel;
  text: string;
}

interface EventRenderer {
  renderEvent(
    event: EchoEvent,
    capabilities: RenderCapabilities,
  ): readonly RenderChunk[];

  renderResult(
    result: AgentResult,
    capabilities: RenderCapabilities,
  ): readonly RenderChunk[];
}
```

`interactive`、`color` 与 `unicode` 来自启动时的终端能力检测；`verbose` 默认是 `false`，只由显式 CLI `--verbose` 启用。详细模式只能增加经过脱敏且受输出上限约束的诊断信息，不能隐式打开颜色、泄露原始数据或改变 Agent 行为。

渲染器必须满足：

- 不执行工具、请求模型、修改 Session 或决定审批/终止；
- 相同事件与能力输入产生确定性输出，不依赖墙钟时间或全局可变状态；
- Turn 进度、审批、警告和诊断写入 stderr；正常最终答复写入 stdout；
- `--help`、`--version` 和未来显式机器输出是 Turn 外的 stdout 例外；
- 非 TTY、CI 或禁用颜色时不得产生 ANSI 控制序列或动态覆盖；
- 颜色和 Unicode 不能是状态含义的唯一载体；
- 不渲染推理字段、密钥、绝对个人路径或未经脱敏的参数；
- 工具成功与 Turn 完成必须使用不同语义，不能由人类文本猜测状态；
- 截断、拒绝、取消和限制必须明确显示，不能省略为普通成功。

颜色、标签、间距和完整示例见 [cli-ux.md](./cli-ux.md)。未来 UI 必须消费 `EchoEvent`，不得解析 CLI 文本。

## 7. 会话存储

```ts
interface SessionStore {
  append(event: EchoEvent): Promise<void>;
  read(sessionId: SessionId): AsyncIterable<EchoEvent>;
}
```

- 首版实现为 `.echo/sessions/*.jsonl`；
- `append` 必须保持事件顺序并避免部分 JSON 行；
- SessionStore 不负责上下文取舍；
- 文件默认不纳入 Git；
- 持久化失败必须可观测，但不得因此泄露未脱敏原始数据。

## 8. Context Builder

```ts
interface ContextBudget {
  maxApproxTokens: number;
  reservedOutputTokens: number;
}

interface ContextProjection {
  messages: ModelMessage[];
  approximateTokens: number;
  omittedEventCount: number;
  truncations: Array<{ reason: string; originalSize: number; keptSize: number }>;
}

interface ContextBuilder {
  build(events: readonly EchoEvent[], budget: ContextBudget): ContextProjection;
}
```

不变量：

- 系统安全约束和当前用户目标不得因预算裁剪；
- 工具调用与对应结果不得形成无法解释的孤立消息；
- 被截断内容必须带明确标记；
- 影响当前状态的重要事实必须能从保留内容或摘要中重建。

## 9. Orchestrator 结果

```ts
type AgentStopReason =
  | "completed"
  | "max_steps"
  | "repeated_tool_call"
  | "policy_denied"
  | "provider_error"
  | "tool_error"
  | "cancelled";

interface AgentResult {
  sessionId: SessionId;
  turnId: TurnId;
  status: "completed" | "failed" | "cancelled" | "limited";
  stopReason: AgentStopReason;
  finalText?: string;
  steps: number;
  toolCalls: number;
  error?: EchoError;
}
```

`status: "completed"` 只表示 Orchestrator 正常收到最终答复，不自动证明用户任务在现实中正确完成。演示与测试应通过测试命令等外部证据验证结果。

## 10. 配置契约

配置来源按优先级合并：

```text
CLI 显式参数 > 环境变量 > 项目配置 > 用户配置 > 内置默认值
```

首版至少支持：

| 目的 | 推荐环境变量 | 是否敏感 |
| --- | --- | --- |
| API 地址 | `ECHO_BASE_URL` | 否 |
| API Key | `ECHO_API_KEY` | 是 |
| 模型名 | `ECHO_MODEL` | 否 |
| 工作区 | CLI 参数或当前目录 | 否 |
| 安全模式 | `ECHO_SAFETY_MODE` | 否 |

- API Key 不得写入项目配置、事件、命令输出或子进程环境；
- 配置诊断只能显示 Key 是否存在，不显示其值或可还原片段；
- 未知配置键应产生警告或校验错误，避免静默拼写错误；
- 项目配置文件依次尝试 `echo.config.json` 与 `.echo-config.json`；项目配置不得提供
  API Key。
- 内置默认值为：`balanced`、24 个 Step、120 秒工具超时、20,000 字符工具输出上限、
  300 秒 Provider 请求超时、32,000 近似 token 上下文与 4,000 输出 token 预留。

## 11. 错误模型

```ts
type EchoErrorCategory =
  | "configuration"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_network"
  | "provider_protocol"
  | "invalid_tool_input"
  | "workspace_violation"
  | "policy_denied"
  | "tool_timeout"
  | "tool_execution"
  | "storage"
  | "cancelled"
  | "internal";

interface EchoError {
  category: EchoErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
  cause?: unknown; // 仅进程内诊断，不直接持久化或发送给模型
}
```

错误消息应说明“发生了什么”和“用户可以做什么”。只有明确的瞬时错误可以标记为 `retryable`。

## 12. CLI 退出码

首版按以下稳定类别映射：

| 退出码 | 含义 |
| --- | --- |
| `0` | 正常完成 |
| `1` | 未分类运行失败 |
| `2` | 参数或配置错误 |
| `3` | Provider 或网络错误 |
| `4` | 工具执行失败 |
| `5` | 安全策略拒绝 |
| `6` | 达到步数或重复调用限制 |
| `130` | 用户取消 |

CLI 必须保证同一失败类别在交互与非交互运行中使用相同退出码。

## 13. 跨模块强制不变量

1. Provider 不能执行工具或控制循环。
2. 每个已请求工具调用必须进入一个且仅一个终态。
3. 硬拒绝不能被任何模式、用户批准或模型请求覆盖。
4. 任何工具路径不得逃逸规范化后的工作区根目录。
5. API Key 不得进入事件、日志、模型上下文或工具子进程。
6. 发送给模型的重要操作结果必须能从脱敏事件重建。
7. 输出截断必须显式标记，不能伪装成完整结果。
8. 取消和超时必须传播至在途 Provider 请求与子进程。
9. CLI、测试和未来 UI 不得依赖 Provider 私有响应结构。
10. 核心模块不得依赖 Agent 框架或第三方托管代码执行能力。
11. 核心模块不得依赖 CLI Renderer；渲染不得改变 Agent 状态或工具结果。
12. 非交互输出不得依赖颜色、动画或 Unicode 才能表达状态。
13. tool-call ID 在 Session 内必须非空且唯一，协议违规不得进入工具管线。
14. SessionStore 故障补偿必须以已持久化事件去重，不能制造第二个工具或 Turn 终态。

## 14. 接受流程

本文件在以下条件满足后由 `Proposed / 0.1` 升级为 `Accepted / 1.0`：

- 对应 TypeScript 接口已实现；
- Fake Provider 覆盖完整 Agent Loop；
- 六个基础工具通过契约测试；
- 安全和事件不变量有自动化测试；
- CLI 退出码与真实行为一致；
- 文档中的临时字段和默认值已清理。
