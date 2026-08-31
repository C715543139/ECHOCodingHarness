# ECHO Harness 核心契约

> 状态：Accepted
>
> 版本：1.8
>
> 最后更新：2026-08-31

## 1. 文档目的

本文定义 ECHO Harness 各核心模块之间的稳定边界。可编译共享类型位于 `src/contracts/`；本文仍是语义与不变量的权威来源。P1-0 已冻结配置、应用服务、Session 查询、事件模式版本、配置错误码和退出语义；后续实现必须先符合本文，再改运行时。

P1-2A 已使运行时执行本节配置规则。P1-2B 已实现 `GET /models` 发现、进程内缓存，以及发现失败不阻断已配置模型。P1-1A 已将 `run` 接到 `ApplicationService`。P1-1B 已实现 `echo-harness chat`、Slash 与粘贴边界。该过渡不得被解读为可以同时维持两套公共契约。P1 契约以 [ADR-0002](./decisions/0002-p1-config-artifact-root.md)、[ADR-0003](./decisions/0003-p1-application-service-session.md)、[ADR-0005](./decisions/0005-restore-artifact-config.md) 与 [ADR-0006](./decisions/0006-reasoning-session-events.md) 为准。P2 Web 传输与 UI 契约分别冻结在 [web-api.md](./web-api.md) 和 [web-ui.md](./web-ui.md)。P2 已交付固定工作区 loopback server/adapter、一次性 bootstrap 认证、React 主壳、业务 Session/Turn/审批/Trace/SSE API、真实 HTTP/SSE transport 与 `echo-harness web` 启动契约（默认打开已验证的 bootstrap URL，`--no-open` 只打印同一地址）。这不改变本文件中已交付的领域接口。

文中的“必须”“不得”是强约束，“应”是默认约束，“可以”表示可选能力。

## 2. 命名与标识

所有标识在单个会话中唯一，并使用不含个人信息的随机或时间有序 ID：

```ts
type SessionId = string;
type TurnId = string;
type StepId = string;
type ToolCallId = string;
type EventId = string;
type EndpointFingerprint = string & { readonly brand: "EndpointFingerprint" };

interface ProviderIdentity {
  kind: "openai-compatible";
  name: "openai-compatible";
  endpointFingerprint: EndpointFingerprint;
}
```

- 时间统一存储为 ISO 8601 UTC 字符串；
- 文件路径在工具边界使用相对工作区路径；
- 绝对路径只在 Execution 内部短暂存在，不发送给模型或写入可分享材料；
- 对模型名、Provider 名和工具名使用稳定的小写标识；
- `EndpointFingerprint` 是不可逆的 endpoint 标识（由 scheme、host 与可选 port 派生），不得是原始 URL、凭据、userinfo 或这些值的可逆编码。生成算法由 P1-1A 实现为 SHA-256 十六进制摘要；P0 `model.started.provider` 仍是适配器名字符串。

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
  | { role: "assistant"; content: string; reasoning?: string; reasoningContent?: string; reasoningDetails?: unknown[]; toolCalls?: ModelToolCall[] }
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
  | { type: "reasoning_delta"; delta: ModelReasoning }
  | { type: "tool_call_delta"; callId: ToolCallId; delta: string }
  | { type: "tool_call"; call: ModelToolCall }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "completed"; finishReason: ModelFinishReason };

interface ModelReasoning {
  reasoning?: string;
  reasoningContent?: string;
  reasoningDetails?: unknown[];
}

type ModelFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "unknown";
```

Provider 必须保证同一调用中的事件顺序稳定。若上游只提供参数增量，Provider 必须在发出完整 `tool_call` 前完成聚合和 JSON 解析。

### 3.4 模型目录

单 Provider 模型目录与 chat completion 流分离。`ModelProvider.stream` 不得列出模型。候选列表通过 `ModelCatalogClient.listModelIds` 读取：

```ts
interface ModelCatalogClient {
  listModelIds(options: { signal: AbortSignal; timeoutMs?: number }): Promise<readonly string[]>;
}

interface ModelCatalogSnapshot {
  status: "ok" | "failed";
  source: "discover" | "manual";
  models: readonly string[];
  cached: boolean;
  refreshed: boolean;
  configuredModel: string;
  error?: EchoError;
}
```

- 手动目录返回配置文件中的唯一非空模型 ID，不访问网络；
- 自动发现只允许当前 OpenAI-compatible 客户端请求 `GET {baseUrl}/models`，只使用响应中的模型 ID，不推断价格、上下文长度或工具能力；
- 发现列表缓存在当前进程内；`run` 不得发现；`chat` 仅在 `/model` 或 `/model refresh` 需要候选项时延迟发现；
- `/model refresh` 只在 `discover` 源下绕过缓存；手动目录必须返回可展示错误，不得静默当作成功；
- 发现失败不得阻止已配置模型的实际调用；快照仍包含该模型 ID；
- 鉴权、网络、超时、取消、无效响应、空列表和重复 ID 必须映射为稳定 `EchoError`，不得回显 API Key、授权头或 Provider 原始敏感响应；
- `/model <id>` 只更新当前 Session 并从下一个尚未开始的 Turn 生效，追加 `model.changed`，不写回配置文件。
- Chat 入口是 `listModelCandidates`：返回当前模型、候选项和脱敏后的 `error` 字符串。新会话模型优先级为 CLI `--model` 高于配置文件 `model`，且 `run` 不查询目录。

P1-2B 实现发现与缓存。P1-1B 的 Chat `/model` 通过目录端口消费该运行时，不复制第二套 `GET /models`。

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

精确 JSON Schema 位于 `src/tools/` 的工具定义中，并由工具注册、输入校验和集成测试验证
其与模型声明一致。

## 5. 安全策略契约

```ts
type SafetyMode = "safe" | "balanced" | "auto";

type PolicyDecision =
  | { action: "allow"; reason: string; ruleId: string }
  | { action: "ask"; reason: string; approvalKey: string; ruleId: string }
  | { action: "deny"; reason: string; hard: boolean; ruleId: string };

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
- P2 新 Writer 的每种 `PolicyDecision` 必须携带稳定 `ruleId`，且 `reason` 必须已经脱敏，不得包含绝对路径、家目录或秘密；
- 对应授权、审批或拒绝事件写入可选 `policyRuleId` 与脱敏原因；旧 Session 缺少这些字段时只标记 `legacy_unrecorded`，不得由前端补算，也不单独提升 Session schema。
- Policy Explain 事实按 `toolCallId` 聚合完整事件序列，并严格区分三层：`policy`（`action`/`ruleId`/`reason`/`hard?`）、`approval`（`not_required`/`pending`/`allowed_once`/`allowed_session`/`denied`/`failed`）与 `execution`（`not_started`/`authorized`/`running`/`completed`/`failed`/`denied`/`cancelled`）。
- 原始 `action=ask` 在用户批准或拒绝后仍保持 `ask`，不得因后续 `tool.authorized` 或 `tool.denied` 改写为 `allow` 或 `deny`。
- `approval.denied` 的 `failed` 与 `denied` 只由可选结构化字段 `outcome` 判别：新 Writer 必须写入 `outcome: "failed"`（审批处理器失败）或 `outcome: "denied"`（用户拒绝或非交互默认拒绝）；不得根据 `reason` 展示文案推断。旧事件缺少 `outcome` 时按 `denied` 兼容读取，不提升事件或 Session schema。

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
  | EventEnvelope<"session.resumed", SessionResumed>
  | EventEnvelope<"turn.started", TurnStarted>
  | EventEnvelope<"step.started", StepStarted>
  | EventEnvelope<"context.projected", ContextProjected>
  | EventEnvelope<"model.started", ModelStarted>
  | EventEnvelope<"model.text", ModelText>
  | EventEnvelope<"model.text_delta", ModelTextDelta>
  | EventEnvelope<"model.reasoning", ModelReasoning>
  | EventEnvelope<"model.tool_call", ModelToolCallCompleted>
  | EventEnvelope<"model.completed", ModelCompleted>
  | EventEnvelope<"model.failed", OperationFailed>
  | EventEnvelope<"model.changed", ModelChanged>
  | EventEnvelope<"safety.changed", SafetyChanged>
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

P1.5 版本 3 的正文持久化类型为：

```ts
type ModelText = Readonly<{
  text: string;
  partial?: true;
}>;
```

Provider 的 `text_delta` 仍是实时传输事件，但版本 3 Writer 必须在内存中按到达顺序聚合，并为每次模型响应至多写一条非空 `model.text`。Provider 流在完成前失败或取消时，已经收到的非空正文写成 `partial: true`；正常结束（包括 `finishReason=length`）不带 `partial`，由 `model.completed` 和 Turn 终态表达限制原因。聚合正文必须在对应 `model.completed`、`model.failed` 或 `turn.cancelled` 前写入。

`model.text_delta` 仅作为版本 1/2 及修订前本地版本 3 Session 的读取兼容事件保留。Reader、Session 查询、Context 投影和 Renderer 必须能把旧 delta 按 Step 聚合；新 Writer 不得持久化它。同一 Step 同时出现 `model.text` 与 `model.text_delta` 视为损坏 Session，必须安全拒绝，不能拼接形成重复正文。

`model.reasoning` 的 `reasoning_details` 按整组归一化：仅当非空数组的每一项都严格为 `reasoning.text`、对象键只来自 `type`/`text`/`format`/`index`，且按到达顺序拼接的非空 `text` 与已有 `reasoning` 或 `reasoningContent` 完全一致时，Writer 省略该数组。若没有字符串推理字段，则把同样满足约束的非空拼接文本写为 canonical `reasoning` 并省略数组。只要包含额外键、特殊或未知类型、空文本，或拼接结果不一致，Writer 就必须整组原样保留数组及顺序；Reader 继续接受历史日志中的 `reasoning_details`。

`model.tool_call` 必须保存 Provider 聚合后的完整、Provider 无关工具调用，包括调用 ID、工具名和经脱敏但尚未做语义规范化的参数。`tool.requested` 则记录进入工具管线的输入及其规范化结果；即使后续校验、审批或执行失败，也能区分“模型原始请求”与“ECHO 实际尝试执行的操作”。

同一 Session 中每个 `ModelToolCall.id` 必须是非空且唯一的稳定标识。同一模型响应内重复、
跨 Step 重用或空白 ID 均映射为不可重试的 `provider_protocol` 错误；该响应不得产生
`tool.requested`，也不得执行任何工具。

`approval.requested` 记录待审批操作及风险原因，P2 新 Writer 必须附加 `policyRuleId`；`approval.granted` 记录本次或当前 Session 的授权范围；`approval.denied` 记录拒绝或审批失败，并可回写触发该审批的 `policyRuleId`。P2 新 Writer 必须持久化结构化 `outcome: "denied" | "failed"`：用户选择 deny 与无 handler 的非交互默认拒绝写 `denied`，审批处理器抛错且未取消写 `failed`。`reason` 仍是脱敏展示文案，不参与分类。旧 Session 缺少 `outcome` 时按 `denied` 兼容读取，不得由展示文本补算，也不提升事件 schema。`tool.authorized` 与 `tool.denied` 在新 Writer 下同样携带 `policyRuleId` 与脱敏原因。旧事件字段缺失时 Reader 必须保持可读。首批 payload 类型在 `src/contracts/events.ts` 中固化，后续实现只能通过共享契约变更细化。事件的公共字段和状态语义应保持稳定，以便 CLI 与未来界面复用。

P0 事件模式版本为 `1`（缺省视为 1）。P1 事件模式版本为 `2`：必须能记录 Session/Turn/Step 标识与时间、模型与安全模式变化、Context 投影版本/预算/估算量/裁剪原因摘要、工具请求、策略 rule ID、审批、执行终态、命令耗时/退出码/截断，以及 Turn 终态与可引用验证结果。`session.resumed`、`model.changed` 和 `safety.changed` 属于版本 2。P1.5 事件模式版本为 `3`：新 Session 写入版本 3，增加聚合 `model.text`、聚合 `model.reasoning` 与停止原因 `output_limit`。版本 3 Writer 不写 `model.text_delta`；Reader 接受并验证两个聚合事件，同时兼容旧版本及修订前本地 v3 的正文增量。版本 2 Session 继续可读和恢复，但不补造历史推理字段。恢复时遇到未知事件类型、未知未来版本、损坏聚合 payload 或同一 Step 混用两种正文表示必须失败，不得丢弃后继续。现有 payload 的新增字段在版本 2 中可选，P0 写入方可省略。CLI `EventRenderer` 对 `model.reasoning` 保持无输出，对新旧正文表示产生相同聚合显示，不得改变 stdout/stderr 契约。

`session.started.provider`（可选）与 `session.resumed.provider` 必须是 `ProviderIdentity`，不得使用任意 `string` 或原始 endpoint URL。`model.started.provider` 保持 P0 适配器名；版本 2 可附加可选 `endpointFingerprint`。

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
  columns?: number;
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

`interactive`、`color` 与 `unicode` 来自启动时的终端能力检测；`verbose` 默认是 `false`，只由显式 CLI `--verbose` 启用。`columns` 是可选的可见列预算，缺省按 80 列换行；它只影响表现层换行与窄终端堆叠，不得改变事件顺序、Agent 行为或 stdout/stderr 通道。详细模式只能增加经过脱敏且受输出上限约束的诊断信息，不能隐式打开颜色、泄露原始数据或改变 Agent 行为。

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

颜色、标签、间距和完整示例见 [cli-ux.md](./cli-ux.md) 与 [p1-cli.md](./plans/p1-cli.md) 第 5 节。未来 UI 必须消费 `EchoEvent`，不得解析 CLI 文本。

## 7. 会话存储

```ts
interface SessionStore {
  append(event: EchoEvent): Promise<void>;
  read(sessionId: SessionId): AsyncIterable<EchoEvent>;
}

interface CreateSessionRecordInput {
  workspaceRoot: string;
  provider: ProviderIdentity;
  model: string;
  safetyMode: SafetyMode;
  eventSchemaVersion: number;
}

interface ResumeSessionRecordInput {
  workspaceRoot: string;
  sessionId: SessionId;
  provider: ProviderIdentity;
}

interface SessionRepository extends SessionStore {
  create(input: CreateSessionRecordInput): Promise<SessionSummary>;
  resume(input: ResumeSessionRecordInput): Promise<SessionQueryView>;
  list(workspaceRoot: string): Promise<readonly SessionSummary[]>;
  readAll(sessionId: SessionId): Promise<readonly EchoEvent[]>;
  getQueryView(sessionId: SessionId): Promise<SessionQueryView>;
  delete(sessionId: SessionId): Promise<void>;
}
```

- 首版实现为 `.echo/sessions/*.jsonl`；
- `append` 必须保持事件顺序并避免部分 JSON 行；
- SessionStore 不负责上下文取舍；
- `SessionRepository` 是 P1 查询与恢复边界：必须支持创建、列出、读取、恢复、精确删除单条 Session，以及按 Turn/Step 整理事件。P2 必须调用该接口，不得解析 JSONL 文本细节或 CLI 输出；删除只能命中固定工作区内校验后的普通 Session 文件；
- 文件默认不纳入 Git；
- 持久化失败必须可观测，但不得因此泄露未脱敏原始数据；
- 恢复只从事件事实重建对话、当前模型与安全模式。损坏、不完整、跨工作区、Provider 不一致或不兼容版本必须安全失败。

### 7.1 应用服务

```ts
interface ApprovalResponseInput {
  sessionId: SessionId;
  turnId: TurnId;
  toolCallId: ToolCallId;
  approvalKey: string;
  choice: "deny" | "once" | "session";
}

type ApprovalResponseResult =
  | { outcome: "accepted"; choice: "deny" | "once" | "session" }
  | { outcome: "rejected"; reason: "duplicate" | "expired" | "not_pending" };

interface ApplicationService {
  createSession(input: CreateSessionInput): Promise<SessionRuntimeState>;
  resumeSession(input: ResumeSessionInput): Promise<SessionRuntimeState>;
  listSessions(workspaceRoot: string): Promise<readonly SessionSummary[]>;
  getSession(sessionId: SessionId): Promise<SessionQueryView>;
  deleteSession(sessionId: SessionId): Promise<void>;
  runTurn(input: RunTurnInput): Promise<AgentResult>;
  cancelTurn(sessionId: SessionId, turnId?: TurnId): Promise<void>;
  respondToApproval(input: ApprovalResponseInput): Promise<ApprovalResponseResult>;
  setSessionModel(sessionId: SessionId, modelId: string): Promise<SessionRuntimeState>;
  setSessionSafetyMode(sessionId: SessionId, mode: SafetyMode): Promise<SessionRuntimeState>;
  getRuntimeState(sessionId: SessionId): Promise<SessionRuntimeState>;
}
```

`run` 与 `chat` 必须通过同一个 `ApplicationService` 创建、恢复、执行和取消 Turn，并提交精确绑定到当前 Turn、工具请求与 `approvalKey` 的审批响应。重复、过期或非待审批的响应必须返回 `rejected`，不得当作成功或抛出未分类错误。CLI 参数解析、readline、bracketed paste 适配器和渲染器不得持有 Agent 决策。当前模型与安全模式是可测试的运行时状态；Agent Loop 在每个 Turn 开始和每次策略判断时读取当前有效值。切换从下一个尚未开始的 Turn 生效，并分别追加 `model.changed` 与 `safety.changed`。`model.changed` 只记录会话内模型 ID 与来源，不保存发现列表或凭据。P1-1A 已把 `run` 接到该服务。P1-1B 已实现 `echo-harness chat`、`--resume`、Slash、Ctrl+C 与 bracketed paste 适配器，并用 `resolveNewSessionSetting` / `resolveResumeSessionSetting` 落实 CLI > session > config。`/model` 与 `/model refresh` 只消费可注入的模型目录端口，不在 Chat 内实现第二套 `GET /models` 发现与缓存。P1-2A 已实现配置加载器与 artifact-root 解析；P1-2B 已实现模型目录发现与进程内缓存。

P2.5 的 `deleteSession` 只删除用户明确选择的单条 Session。`ActiveTurnCoordinator` 必须串行执行活动
目标的取消、终态等待和删除；repository 在删除开始后拒绝该 Session 的新追加，并只操作固定工作区
内经过 ID 校验、非链接的普通 JSONL 文件。取消或删除失败不得清理内存投影或返回成功。

### 7.2 P2 Web adapter 契约

P2 Web adapter 是 `ApplicationService`、Session 查询和共享配置服务的传输适配器，不是新的领域
服务。它必须遵守以下不变量：

- 固定工作区来自服务启动参数，不接受浏览器路径；
- 整个 Web 服务进程同时只允许一个活动 Turn；
- Session 创建、恢复、取消、审批、模型和安全模式继续调用本节接口；
- Session 删除由进程级协调器执行；活动目标必须先取消并等待 Turn 终态持久化，删除失败保留记录；
- Provider 配置通过 `createProviderConfigService` 复用 CLI 背后的 Schema、artifact-root、写锁
  和原子写入，不调用或解析 CLI；Web 只使用受限的 `saveProviderSettings` merge，CLI wizard 只使用
  完整校验后的 `replacePersistentConfig`；API Key 仍只来自 `ECHO_API_KEY`，`discoverModels` 不会
  自动保存；merge 在读取或 Schema 失败时必须拒绝并保持原文件不变；
- Web DTO 是内部领域对象的有界脱敏投影，不直接序列化类实例或原始 JSONL；
- Chat 历史只投影聚合 `model.text`，Trace 不把 chunk 或 `model.reasoning` 作为记录；
- P2 新 Writer 的每种 `PolicyDecision` 都携带稳定 rule ID，并把 rule ID 与原因写入相应授权、审批
  或拒绝事件；旧事件字段缺失时只标记不可用；
- Policy 与 Verification 结论来自结构化领域事实，前端不得重新判断；命令退出码 0 只证明命令成功
  退出，不自动证明修改正确；
- HTTP 幂等、SSE 恢复和浏览器认证属于 [web-api.md](./web-api.md)，不能改变 Agent Loop 语义；
- P2 不提供 Session 导出接口；复盘继续使用 CLI 与 Session JSONL。

P2 实现若需要扩大 `ApplicationService`，必须在 `src/contracts/application.ts` 增加最小、客户端无关的
能力并同时补充 CLI 回归测试；不得为 WebUI 创建只在浏览器路径成立的第二套 Session 状态机。

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

- 系统安全约束和当前用户目标不得因预算裁剪；当前目标按独立保留项计入预算一次，插入在先前对话之后、当前 Turn 的 assistant/tool 消息之前，不得与 `ConversationTurn.user` 双重计费，也不得在末尾按“是否已有 user”再 `push`；
- 恢复或多轮继续时，先前 Turn 的用户目标必须作为 `user` 消息进入投影，不得只保留 assistant 回复；连续 Turn 即使目标文本相同、或 `turnId` 缺省/复用，也必须各保留一条；
- 工具调用与对应结果不得形成无法解释的孤立消息；
- 被截断内容必须带明确标记；
- 影响当前状态的重要事实必须能从保留内容或摘要中重建。

## 9. Orchestrator 结果

```ts
type AgentStopReason =
  | "completed"
  | "max_steps"
  | "repeated_tool_call"
  | "output_limit"
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

P1 普通配置优先级（[ADR-0002](./decisions/0002-p1-config-artifact-root.md)）：

```text
CLI 显式参数 > echo.config.json
```

字段缺省（如未写出的 `safetyMode` 使用 `balanced`）是结构默认值，不是第三配置来源，也不进入 `cli | session | config` 来源诊断。`cli | session | config` 只描述会话内模型与安全模式的有效值来源。

唯一持久配置文件为 `<artifact-root>/config/echo.config.json`（[ADR-0005](./decisions/0005-restore-artifact-config.md) 恢复 [ADR-0002](./decisions/0002-p1-config-artifact-root.md) 第 2.1 节）。`artifact-root` 根据 CLI 模块或可执行文件位置解析，不得使用 `process.cwd()` 或工作区 `.echo/config`。`ECHO_API_KEY` 是唯一正式支持的秘密环境变量，不参与普通配置合并。

| 目的 | P1 来源 | 是否敏感 |
| --- | --- | --- |
| API 地址 | 配置文件 `baseUrl` 或 CLI `--base-url` | 否 |
| API Key | `ECHO_API_KEY` | 是 |
| 模型名 | 配置文件 `model` 或 CLI `--model` | 否 |
| 工作区 | CLI `--workspace` 或当前目录 | 否 |
| 安全模式 | 配置文件 `safetyMode` 或 CLI `--safety-mode` | 否 |
| 模型目录 | 配置文件 `modelCatalog` | 否 |

P1 不迁移旧工作区、用户目录或 ADR-0004 工作区 `.echo/config` 中的配置文件。操作者使用 `echo-harness config` 写入产物配置。

- API Key 不得写入配置文件、事件、命令输出或子进程环境；
- 配置诊断只能显示 Key 是否存在，不显示其值或可还原片段；
- 未知键、`apiKey` 和 URL 内嵌凭据必须产生配置错误并拒绝加载，不得静默忽略；
- 缺少配置文件时 `run`/`chat` 使用退出码 `2`，提示执行 `echo-harness config`，不得自动创建含真实 Provider 信息的文件；
- 手动模型目录必须包含唯一非空模型 ID，且默认模型位于列表中；自动发现模式不持久化完整列表；
- 自动发现由 P1-2B 在进程内缓存；`run` 不调用 `/models`；发现失败不得阻断已配置模型；
- 省略的限制字段在实现时使用既有内置数值：`balanced`、24 个 Step、120 秒工具超时、40,000 字符工具输出上限、
  300 秒 Provider 请求超时、256,000 近似 token 上下文与 16,000 输出 token 预留。这些是字段缺省规则，不是独立配置来源，数值为 approximate。
- 稳定配置错误码见 `CONFIG_ERROR_CODES`：`CONFIG_MISSING`、`CONFIG_UNKNOWN_KEY`、`CONFIG_CREDENTIAL_FORBIDDEN`、`CONFIG_PROVIDER_MISMATCH`、`CONFIG_SESSION_INCOMPATIBLE` 等。

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

CLI 必须保证同一失败类别在交互与非交互运行中使用相同退出码。缺少或非法配置（含 P1 配置文件缺失、Session 无法恢复、Provider 不匹配）映射为 `2`。Chat 空闲 `Ctrl+C` 为 `130`；`/quit` 为 `0`。可编译映射为 `CLI_EXIT_CODES` 与 `exitCodeForAgentResult`。

## 13. 跨模块强制不变量

1. Provider 不能执行工具或控制循环。
2. 每个已请求工具调用必须进入一个且仅一个终态。
3. `safe`、`balanced`、`auto` 的硬拒绝不能被用户批准或模型请求覆盖；P3 Full Access 只按
   ADR-0010 的人类确认门放开集中策略。
4. 内置文件工具路径不得逃逸规范化后的工作区根目录；P3 的广泛访问只通过已确认 Full Access 的
   `run_command` 完成。
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
15. `run` 与 `chat` 必须共享 `ApplicationService`；CLI 与未来 UI 不得复制 Agent 控制流。
16. 普通配置不得再引入工作区/用户文件或除 `ECHO_API_KEY` 以外的秘密环境变量作为正式来源。
17. Slash 命令只解析空闲提示符中的 `typed` 输入；bracketed paste 的一次粘贴最多成为一个用户 Turn，且不得触发 Slash。

## 14. 接受证据

P0 证据使本文在 1.0 被接受：对应 TypeScript 接口、Fake Provider Agent Loop、六个工具、安全与事件不变量、CLI 退出码。

1.1 由 P1-0 冻结，证据为：

- [ADR-0002](./decisions/0002-p1-config-artifact-root.md)、[ADR-0003](./decisions/0003-p1-application-service-session.md) 与 [ADR-0005](./decisions/0005-restore-artifact-config.md)；
- `src/contracts/` 中的 P1 类型、事件版本、`CONFIG_ERROR_CODES`、`CLI_EXIT_CODES` 与 `ApplicationService`；
- `P1_TEST_MATRIX`（每行含 `contractEvidence` 与 `runtimeEvidence`）以及 `tests/unit/contracts/p1-baseline.test.ts`、`tests/unit/contracts/doc-consistency.test.ts`；
- P1-2A 运行时测试覆盖 artifact-root 加载、缺失配置退出码 2、未知键失败，以及不再读取 cwd/`ECHO_BASE_URL`/`ECHO_MODEL`/`ECHO_SAFETY_MODE`。
- P1-2B 运行时测试覆盖 `/models` 发现、进程内缓存、刷新、失败不阻断已配置模型，以及目录错误脱敏。
- P1-1B 运行时测试覆盖 Chat 恢复、Slash、Ctrl+C、bracketed paste，以及默认目录端口接到 `ProcessModelCatalog`。

1.2 由 P1 集成验收确认：矩阵无 `pending:` 行，`run`/`chat`/`config` 与产物 smoke 共用同一契约，且不扩大到 P2。

## 15. P3 目标契约（A0 冻结，A2 存储已实现）

P3 的权威增量见 [ADR-0010](./decisions/0010-full-access-mode.md)、
[ADR-0011](./decisions/0011-workspace-extensions.md) 与 `src/contracts/p3.ts`。A1 完成后运行时
`SafetyMode` 才从当前 `safe | balanced | auto` 迁移为
`safe | balanced | auto | full-access`；A0 的 `P3SafetyMode` 是目标冻结，不代表现在已经可以运行。

Full Access 只有在人类确认后才成为 Session 的有效并持久模式。新 Session 不能仅因配置、CLI 候选
或继承值而静默获得；非交互 CLI 必须使用 `--allow-full-access`，Web 必须提交
`fullAccessConfirmation.acceptedRisk=true`。模型不能调用任何接口改变模式。离开后再次进入必须重新
确认；恢复仍处于 Full Access 的同一 Session 不重复确认。

工作区扩展使用 Manifest/Catalog v1 与 `enabled | disabled | quarantined`。七个模型工具固定为
`extension_init`、`extension_check`、`extension_install`、`extension_list`、`extension_enable`、
`extension_disable`、`extension_uninstall`，且只在 Full Access 可见。安装或启用后的动态工具从下一次
模型请求可见；人类 Web 管理不受当前 Session 模式限制。

P3 不新增模型循环、Session 导出或 Provider 协议。动态工具继续返回 `ToolExecution`，继续产生现有
工具/Policy/终态事件。Catalog 是扩展状态事实源，Session JSONL 不复制 Catalog 内容。A0 验收矩阵
允许 `pending:P3-*`；负责实现的任务必须改为真实测试路径，P3-C3 清零全部 pending 后才能宣称完成。

P3-A2 提供 `WorkspaceExtensionStore` 作为后续 Worker、Registry 与生命周期工具复用的存储 API。它绑定
一个规范化工作区，只管理该工作区的 staging、安装根和 Catalog；Manifest/Catalog、工具 JSON Schema、
路径、链接、名称冲突、完整 SHA-256 和原子写均在此边界验证。Store 的路径派生与内容快照 API 只接收
扩展 ID、内容哈希或 Catalog 条目，不接受调用方提供的工作区路径、扩展根或 owned root；可绕过绑定
工作区的底层文件系统函数不从 `src/extensions/index.ts` 导出。A1/A2 并行期不改冻结
`src/contracts/p3.ts`，EXT-01/02 的测试路径先记录在验收矩阵文档，集成任务统一同步可机读矩阵。

Store 的可选 `reservedToolNames` 只能在全部 `DEFAULT_TOOLS` 之上追加宿主保留名，不能替换或缩减
内置集合；因此测试注入或后续 Registry 组装都不能意外开放内置工具名覆盖。
