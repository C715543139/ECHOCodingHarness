# ECHO Harness 本地 Web API 契约

> 状态：Accepted design contract（类型与 Schema 已由 A1 冻结，HTTP 路由尚未实现）
>
> 版本：1.2
>
> 最后更新：2026-08-30

## 1. 目的与适用范围

本文冻结 P2 浏览器客户端与本地 Web adapter 之间的 HTTP、SSE、DTO、错误和幂等边界。实现以
[ADR-0007](./decisions/0007-local-web-console.md) 为准；核心领域语义继续以
[contracts.md](./contracts.md) 为准。

API 只服务启动时固定的一个工作区，不是远程 API，也不是公共 SDK。`/api/v1` 是首版稳定前缀。
内部类、异常堆栈、完整磁盘路径、原始 JSONL、Provider 请求、API Key 和隐藏推理均不得成为响应。

## 2. 传输与认证

### 2.1 地址

服务只监听：

```text
http://127.0.0.1:<actual-port>
```

默认由系统选择空闲端口；`--port` 可以指定。服务仅接受与实际端口一致的
`Host: 127.0.0.1:<actual-port>`。静态页面与 API 同源。

### 2.2 Bootstrap

CLI 打开或打印：

```text
http://127.0.0.1:<port>/#bootstrap=<one-time-token>
```

页面从 fragment 读取 token，并执行：

```http
POST /api/v1/auth/bootstrap
Content-Type: application/json

{ "token": "<one-time-token>" }
```

成功响应为 `204 No Content`，并设置进程级 Cookie：

```text
HttpOnly; SameSite=Strict; Path=/api/v1
```

页面成功后立即通过 `history.replaceState` 清除 fragment。token 至少包含 256 bit 随机熵，只能成功
兑换一次；失败、重复、过期均返回通用 `401 AUTH_INVALID`，不得透露是哪一种原因。服务退出后 Cookie
失效。

### 2.3 通用请求规则

- 除 bootstrap 外，所有 API 和 SSE 请求必须携带有效认证 Cookie；
- 除一次性 bootstrap 兑换外，改变状态的请求必须使用 `application/json`，并携带
  `X-Echo-Request-Id`；
- `requestId` 是 16–128 字符的随机不透明字符串，不包含身份或路径；
- 默认请求体上限 1 MiB；各字段继续受领域 Schema 的更小限制；
- 默认不启用 CORS，不接受 `Origin: null`、跨源 Origin 或宽松 Host；
- API 响应使用 `Cache-Control: no-store`；
- 所有时间为 ISO 8601 UTC 字符串，所有耗时为非负毫秒整数；
- 所有工作区文件路径均为 `/` 分隔的相对路径。

### 2.4 幂等

幂等键作用域为当前认证 Web 进程中的 `HTTP method + 规范化 route + requestId`。服务端在进程生命
周期内保存已验证请求体与 route 参数的指纹及第一次终态响应：

- 相同键与相同请求指纹重放时，返回第一次的 HTTP 状态和响应体，不再次触发领域副作用；
- 第一请求仍在执行时，重复请求与其合并并等待同一接受/拒绝结果；
- 相同键用于不同请求指纹时返回 `409 IDEMPOTENCY_CONFLICT`；
- 服务重启后不恢复幂等记录；Session 与领域标识仍必须独立拒绝重复审批或已终止 Turn；
- bootstrap token 自身是一次性凭据，不进入该幂等记录。

## 3. 公共信封

### 3.1 成功响应

单对象响应：

```ts
interface ApiResponse<T> {
  readonly data: T;
  readonly requestId: string;
}
```

分页响应：

```ts
interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
```

### 3.2 错误响应

```ts
interface ApiErrorResponse {
  readonly error: {
    readonly code: WebErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly fields?: Readonly<Record<string, string>>;
  };
  readonly requestId: string;
}
```

稳定错误码至少包括：

```text
AUTH_INVALID
ORIGIN_REJECTED
INVALID_REQUEST
NOT_FOUND
SESSION_INCOMPATIBLE
WORKSPACE_MISMATCH
TURN_ACTIVE
TURN_NOT_ACTIVE
STREAM_ACTIVE
APPROVAL_DUPLICATE
APPROVAL_EXPIRED
APPROVAL_NOT_PENDING
IDEMPOTENCY_CONFLICT
CONFIG_INVALID
PROVIDER_UNAVAILABLE
RESYNC_REQUIRED
INTERNAL_ERROR
```

`message` 面向用户且已经脱敏；日志相关 ID 可以进入诊断，异常堆栈不得进入响应。

## 4. 核心 DTO

```ts
type SessionPhase =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'limited';

interface WorkspaceSummaryDto {
  readonly name: string;
  readonly fingerprint: string;
}

interface RuntimeCapabilitiesDto {
  readonly canCreateSession: boolean;
  readonly canSubmitTurn: boolean;
  readonly canChangeRuntime: boolean;
  readonly canCancelTurn: boolean;
  readonly canRespondToApproval: boolean;
  readonly activeSessionId?: string;
  readonly activeTurnId?: string;
  readonly createSessionBlockedReason?: RuntimeBlockReason;
  readonly submitTurnBlockedReason?: RuntimeBlockReason;
  readonly changeRuntimeBlockedReason?: RuntimeBlockReason;
}

type RuntimeBlockReason =
  | 'turn_active'
  | 'provider_unavailable'
  | 'session_unavailable'
  | 'service_stopping';

interface SessionSummaryDto {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly phase: SessionPhase;
  readonly model: string;
  readonly safetyMode: 'safe' | 'balanced' | 'auto';
}

interface ApprovalRequestDto {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly approvalKey: string;
  readonly actionSummary: string;
  readonly riskReason: string;
  readonly allowedChoices: readonly ['deny', 'allow_once', 'allow_session'];
}

interface SessionRuntimeDto extends SessionSummaryDto {
  readonly context: {
    readonly usedApproxTokens: number;
    readonly limitApproxTokens: number;
  };
  readonly pendingApproval?: ApprovalRequestDto;
}

interface SessionViewDto {
  readonly session: SessionRuntimeDto;
  readonly capabilities: RuntimeCapabilitiesDto;
}

interface ProviderConfigDto {
  readonly baseUrl: string;
  readonly catalog:
    | { readonly source: 'discover'; readonly cachedModels: readonly string[] }
    | { readonly source: 'manual'; readonly models: readonly string[] };
  readonly defaultModel: string;
  readonly apiKeyConfigured: boolean;
  readonly writable: boolean;
}
```

`WorkspaceSummaryDto.name` 只能是工作区目录的 basename（1–255，禁止 `/` `\` `:`、控制字符以及 `.` /
`..`），不得接收 Windows 或 POSIX 绝对路径；`fingerprint` 是不可逆标识。Session title 来自脱敏用户
目标或短 ID，不包含模型生成的未经检查身份信息。运行时 JSON Schema 对全部跨 HTTP/SSE 边界 DTO 强制
这些长度与数组上限；`Page` 与 `ApiResponse` 由统一工厂生成。

`RuntimeCapabilitiesDto` 是服务端对当前选中 Session 和进程状态的事实投影，前端不得自行推导权限：

| 状态 | `canCreateSession` | `canSubmitTurn` | `canChangeRuntime` | `canCancelTurn` | `canRespondToApproval` |
| --- | --- | --- | --- | --- | --- |
| Provider 与当前 Session 可用且无活动 Turn | `true` | `true` | `true` | `false` | `false` |
| 当前 Session 拥有活动 Turn | `true` | `false` | `false` | `true` | 仅等待审批时为 `true` |
| 其它 Session 拥有活动 Turn | `true` | `false` | `false` | `false` | `false` |
| 服务正在关闭 | `false` | `false` | `false` | `false` | `false` |

Provider 或当前 Session 不可用时，相应能力为 `false` 并提供稳定 `*BlockedReason`。活动 Turn 本身不
阻止创建空 Session，因此该场景不得把 `canCreateSession` 设为 `false`。`ApprovalRequestDto` 的摘要
必须有界并已脱敏，不返回原始敏感工具参数。

## 5. 启动与配置 API

### 5.1 `GET /api/v1/bootstrap`

返回页面首屏所需的有界状态：

```ts
interface BootstrapDto {
  readonly workspace: WorkspaceSummaryDto;
  readonly provider: ProviderConfigDto;
  readonly capabilities: RuntimeCapabilitiesDto;
  readonly suggestedSessionId?: string;
}
```

不内联完整 Session 列表、事件或模型响应。

### 5.2 `GET /api/v1/provider`

返回 `ProviderConfigDto`。API Key 只返回 `apiKeyConfigured`，不返回值、长度、前后缀或来源路径。

### 5.3 `PUT /api/v1/provider`

请求：

```ts
interface UpdateProviderConfigRequest {
  readonly baseUrl: string;
  readonly catalog:
    | { readonly source: 'discover' }
    | { readonly source: 'manual'; readonly models: readonly string[] };
  readonly defaultModel: string;
}
```

服务端复用 CLI 的严格配置 Schema、URL 规范化、目录规则和原子写入。成功返回新的
`ProviderConfigDto`。不得通过该端点设置、清除或回显 API Key。活动 Turn 存在时返回
`409 TURN_ACTIVE`。

### 5.4 `POST /api/v1/provider/discover`

使用尚未保存的候选 Base URL 或当前配置执行一次有界模型发现：

```ts
interface DiscoverModelsRequest {
  readonly baseUrl: string;
}

interface DiscoveredModelsDto {
  readonly models: readonly string[];
  readonly fetchedAt: string;
}
```

请求使用服务端环境中的 `ECHO_API_KEY`。错误必须映射为现有 Provider 类别并脱敏。发现不会自动
写配置；用户仍需显式保存。

## 6. Session API

### 6.1 `GET /api/v1/sessions?cursor=<cursor>&limit=<1..100>`

按 `updatedAt` 降序返回固定工作区内的 `Page<SessionSummaryDto>`。默认 `limit=30`。cursor 是不透明
值，不得编码绝对路径。

### 6.2 `POST /api/v1/sessions`

请求：

```ts
interface CreateSessionRequest {
  readonly model?: string;
  readonly safetyMode?: 'safe' | 'balanced' | 'auto';
}
```

省略字段时使用配置值。成功返回 `201` 和 `SessionViewDto`。`capabilities` 是进程级能力，不是
单个 Session 的私有字段。若进程当前存在活动 Turn，仍允许创建空 Session，但
`capabilities.canSubmitTurn` 与 `capabilities.canChangeRuntime` 为 false。

### 6.3 `GET /api/v1/sessions/:sessionId`

恢复并返回 `SessionViewDto`。损坏、Provider 不匹配或跨工作区 Session 使用现有恢复错误语义，
不得部分展示成可继续会话。

### 6.4 `GET /api/v1/sessions/:sessionId/chat?cursor=<cursor>&limit=<1..100>`

返回按时间正序的聊天投影，默认加载最新 30 个 Turn；向前分页时 cursor 指向更旧边界。

```ts
interface ChatTurnDto {
  readonly turnId: string;
  readonly startedAt: string;
  readonly userText: string;
  readonly responses: readonly {
    readonly step: number;
    readonly text: string;
    readonly partial: boolean;
  }[];
  readonly toolSummaries: readonly {
    readonly toolCallId: string;
    readonly name: string;
    readonly status:
      | 'running'
      | 'awaiting_approval'
      | 'completed'
      | 'failed'
      | 'denied'
      | 'cancelled';
    readonly resultSummary?: string;
  }[];
  readonly status: Exclude<SessionPhase, 'idle' | 'running'> | 'running';
  readonly stopReason?: string;
}
```

`responses` 只来自聚合 `model.text`；不得返回 `model.reasoning` 或历史 delta。

### 6.5 `PATCH /api/v1/sessions/:sessionId/runtime`

请求至少包含一个字段：

```ts
interface UpdateSessionRuntimeRequest {
  readonly model?: string;
  readonly safetyMode?: 'safe' | 'balanced' | 'auto';
}
```

语义与 CLI `/model`、`/safety` 相同，仅改变当前 Session，成功后追加相同领域事件。任意活动 Turn
存在时返回 `409 TURN_ACTIVE`。成功返回更新后的 `SessionViewDto`。

## 7. Turn、取消与审批

### 7.1 `POST /api/v1/sessions/:sessionId/turns`

```ts
interface SubmitTurnRequest {
  readonly text: string;
}

interface AcceptedTurnDto {
  readonly sessionId: string;
  readonly turnId: string;
  readonly acceptedAt: string;
}
```

成功返回 `202`。空白、超限或结构错误返回 `400 INVALID_REQUEST`。进程已有活动 Turn 时返回
`409 TURN_ACTIVE`，响应可包含脱敏的 `activeSessionId` 与 `activeTurnId`，不得自动排队。

### 7.2 `POST /api/v1/sessions/:sessionId/turns/:turnId/cancel`

无业务字段，请求体必须是 `{}`。第一次有效取消返回 `202`；已到终态返回
`409 TURN_NOT_ACTIVE`。取消传播到 Provider、工具进程树和 Session 终态，不能只停止 SSE。
`202` 响应体为：

```ts
interface AcceptedCancellationDto {
  readonly sessionId: string;
  readonly turnId: string;
  readonly state: 'cancelling';
}
```

### 7.3 `POST /api/v1/sessions/:sessionId/approvals/:approvalKey`

```ts
interface ApprovalDecisionRequest {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly decision: 'deny' | 'allow_once' | 'allow_session';
}
```

服务端必须把 URL `approvalKey` 与请求中的 Session、Turn 和 `toolCallId` 一起提交到应用服务。结果
映射为 `accepted`、`duplicate`、`expired` 或 `not_pending`；任何不匹配都不得执行工具。首次
`accepted` 返回 `202` 和：

```ts
interface AcceptedApprovalDto {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly outcome: 'accepted';
}
```

同一 requestId 的重放返回同一 `202`；使用新 requestId 重复提交领域决定分别返回
`409 APPROVAL_DUPLICATE`、`409 APPROVAL_EXPIRED` 或 `409 APPROVAL_NOT_PENDING`。

## 8. Trace 与 Inspector API

### 8.1 事件类型

```ts
type TraceRecordType =
  | 'user'
  | 'context'
  | 'agent'
  | 'tool'
  | 'policy'
  | 'approval'
  | 'verification'
  | 'turn';

interface TraceRecordDto {
  readonly id: string;
  readonly seq: number;
  readonly turnId: string;
  readonly step?: number;
  readonly time: string;
  readonly durationMs?: number;
  readonly type: TraceRecordType;
  readonly label: string;
  readonly status: string;
  readonly parameterSummary?: string;
  readonly resultSummary?: string;
  readonly hasDetails: boolean;
}
```

### 8.2 `GET /api/v1/sessions/:sessionId/trace?after=<seq>&limit=<1..200>`

按 `seq` 正序返回 `Page<TraceRecordDto>`。默认 100。服务端把多个底层事件投影为业务记录；Provider
chunk、`model.reasoning`、内部重试分片和原始请求不得成为独立记录。

### 8.3 `GET /api/v1/sessions/:sessionId/trace/:recordId`

返回按类型区分的结构化详情：

```ts
interface TraceRecordDetailDto extends TraceRecordDto {
  readonly sections: readonly {
    readonly key: 'metadata' | 'parameters' | 'result' | 'limits' | 'evidence';
    readonly title: string;
    readonly fields?: readonly { readonly label: string; readonly value: string }[];
    readonly code?: { readonly language: string; readonly text: string; readonly truncated: boolean };
    readonly diff?: { readonly path: string; readonly text: string; readonly truncated: boolean };
  }[];
  readonly relatedRecordIds: readonly string[];
}
```

Context 详情只返回预算、数量、角色摘要、裁剪/替代原因和截断标记；Policy 详情返回领域层生成的
decision、rule ID、原因和最终执行状态，旧 Session 缺少新增字段时明确标记 unavailable；Verification
详情只引用真实 `run_command` 终态，`exitCode=0` 仅证明该命令成功退出，不自动证明修改正确、测试
充分或模型声明真实。前端不得重新计算 Policy 或从模型文字推断验证成功。

## 9. SSE

### 9.1 `GET /api/v1/sessions/:sessionId/events?after=<seq>`

响应 `text/event-stream`。每个持久 Session `seq` 最多对应一个业务 SSE 事件，SSE `id` 等于该
`seq`。事件数据使用以下判别联合：

```ts
interface ProjectionDeltaDto {
  readonly view: SessionViewDto;
  readonly chatTurn?: ChatTurnDto;
  readonly traceRecords?: readonly TraceRecordDto[];
}

type WebStreamEvent =
  | {
      readonly type: 'session.updated' | 'record.upsert';
      readonly sessionId: string;
      readonly seq: number;
      readonly delta: ProjectionDeltaDto;
    }
  | {
      readonly type: 'approval.pending';
      readonly sessionId: string;
      readonly seq: number;
      readonly approval: ApprovalRequestDto;
      readonly delta: ProjectionDeltaDto;
    }
  | {
      readonly type: 'turn.terminal';
      readonly sessionId: string;
      readonly seq: number;
      readonly turnId: string;
      readonly status: 'completed' | 'failed' | 'cancelled' | 'limited';
      readonly stopReason?: string;
      readonly delta: ProjectionDeltaDto;
    }
  | {
      readonly type: 'resync.required';
      readonly sessionId: string;
      readonly lastAvailableSeq: number;
      readonly reason: 'history_gap' | 'projection_version_changed';
    };
```

传输格式示例：

```text
id: <session-seq>
event: record.upsert
data: {"type":"record.upsert","sessionId":"...","seq":42,"delta":{...}}
```

同一进程级认证 Cookie 最多保持一个 Session SSE，因此多个标签页也共享这一限制。存在活动 Turn
时，该流必须绑定活动 Turn 所属 Session；浏览其他历史 Session 使用普通 GET。没有活动 Turn 时，
客户端可以把流切换到当前选中 Session。第二条并发流返回 `409 STREAM_ACTIVE` 且不影响已有流。

允许事件：

```text
session.updated
record.upsert
approval.pending
turn.terminal
resync.required
heartbeat
```

每个业务事件的数据必须符合 `WebStreamEvent` 对应分支。`ProjectionDeltaDto` 可以在一个 Session
`seq` 中同时更新 Chat Turn、Trace 记录与能力快照，避免为同一 `seq` 发送多个相互竞争的事件。
进行中的 Agent 或工具记录通过稳定 record/Turn ID 原位更新，不生成 chunk 行。heartbeat 不携带
业务数据、不设置 SSE `id`，也不推进 Session `seq`。客户端按数值 `seq` 去重，只应用更大的值。

断线恢复顺序：

1. 客户端使用最后确认的 Session seq 重连；
2. 服务端从 Session 查询补齐已提交记录；
3. 再接入直播源；
4. 无法连续补齐时发送 `resync.required` 并关闭流；
5. 客户端重新读取 Chat、Trace 与 Session 快照，不重新 POST Turn。

## 10. 明确不做的导出

P2 不提供 `GET /api/v1/sessions/:sessionId/export` 或任何等价的 Session 下载接口。浏览器不得拼接
Chat/Trace DOM 生成导出文件。复盘继续使用 CLI 与 Session JSONL。

## 11. 生命周期与关闭

服务收到退出信号后立即拒绝新的状态改变请求，向唯一活动 Turn 传播取消，并最多等待 10 秒写入
终态、停止子进程和关闭 SSE。清理完成后退出 0；超时或资源未释放时强制关闭并以非零码退出。

## 12. 契约测试要求

- 所有路由使用 Schema 校验并覆盖成功、边界和拒绝路径；
- Fastify 注入测试覆盖认证、Host、Origin、content-type、body limit 和错误脱敏；
- 幂等测试证明重复 Turn、审批、取消和配置写入不产生第二次副作用；
- SSE 测试覆盖判别联合、单流所有权、有序补齐、重复、断线、heartbeat、resync 和终态；
- DTO 快照不得包含绝对路径、秘密或隐藏推理；
- API 契约变化必须同步本文、类型、测试与 [web-ui.md](./web-ui.md)。
