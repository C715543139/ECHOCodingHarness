# P1.5 推理模型兼容与上下文预算修复计划

> 状态：Accepted
>
> 版本：0.2
>
> 最后更新：2026-08-30
>
> 前置基线：[P1 CLI 完善计划](./p1-cli.md)、[架构设计](../architecture.md)、[核心契约](../contracts.md)、[CLI 展示与交互规范](../cli-ux.md)

## 1. 背景

P1 已交付 `run`、`chat`、Session 恢复、模型切换、安全模式切换和统一 CLI 渲染，但真实 OpenAI-compatible Provider 验收发现了一个跨层缺陷：推理模型可能只返回 Provider-specific reasoning 字段，并在输出预算耗尽时以 `finish_reason=length` 结束；当前适配层只接收普通 `content` 和 `tool_calls`，Agent Loop 又会把“无正文、无工具调用”的结果当作正常完成，最终产生空白 `ECHO` 和无证据的后续结论。

已复现的事实是：

- 同一用户请求可稳定得到 `finishReason=length`；
- Provider usage 显示输出预算已全部消耗；
- 流中存在 `reasoning` / `reasoning_details`，但没有普通 `content`；
- Session 最终记录为 `status=completed`、`finalText=""`；
- 该空轮次的用户目标未进入后续 Context 投影，下一轮模型可能错误声称任务已经解决。

P1.5 是 P1 的可靠性补丁，不启动 WebUI、Skill、插件、MCP 或多智能体工作。它建立推理模型的最小可用契约、修复错误成功语义，并为 P2 提供完整、可重放的 Session 事实。

首轮 P1.5 实现验收后又发现一个存储层问题：Provider 的普通正文虽然会在 Context 投影和 CLI 渲染时重新聚合，但 Session 仍为每个 SSE 分片写入一条完整事件信封。一次 3161 字符的回复实测产生 1756 条 `model.text_delta`，约占 1984 条 Session 事件的 88%，使 3.1 MB 文件中的主要体积来自事件 ID、序号和时间戳，而不是有意义的会话事实。CLI 当前也不逐 token 展示正文，因此逐分片落盘没有为现有 UX、P2 时间线或后续压缩提供相应价值。

## 2. 目标

P1.5 必须实现：

1. 接收 OpenAI-compatible 流中的普通正文、工具调用和常见推理字段；
2. 将 Provider 返回的有效内容统一持久化到现有 Session JSONL；
3. 从 Session 事实重建下一次模型请求，包括推理模型工具续接所需的字段；
4. 禁止空响应被标记为成功；
5. 区分正常完成、部分输出受限、推理预算耗尽、内容过滤和协议空响应；
6. 将当前本地上下文预算提高到 256K，并为模型输出预留 16K；
7. 保持 `/status` 简洁，只显示近似已用量和上限；
8. 用 Fake Provider、单元测试、集成测试和显式真实 Provider smoke 闭合证据；
9. 同步更新受影响的架构、契约、CLI、测试和 P2 文档。
10. 保留 Provider 到 Agent Loop 的流式消费，但把普通正文按一次模型响应聚合为至多一条 Session 事件；
11. 在流失败或取消时保存已经收到的部分正文，并保持旧 Session 可恢复。

## 3. 非目标

P1.5 不实现：

- 精确 tokenizer 或按模型选择 tokenizer；
- LLM 语义压缩、持久滚动摘要或 `/compact`；
- prompt-too-long 自动压缩重试；
- 向量检索、相关性召回或仓库索引；
- `/reasoning`、推理强度切换或 Provider 参数编辑界面；
- 按模型自动覆盖上下文窗口和输出上限；
- 在 CLI 中显示完整思维链；
- P2 WebUI、Context 工作台或 Session 导出界面。

上述能力在 P2 完成后另行规划。P1.5 继续使用当前的近似 token 估算、最近优先窗口、旧步骤规则摘要和确定性截断。

## 4. 冻结决策

### 4.1 单一 Session 存储

P1.5 不新增 private sidecar、第二套 continuation store 或独立推理数据库。现有工作区 Session JSONL 继续作为唯一事实来源：

```text
<workspace>/.echo/sessions/session-<id>.jsonl
```

Provider 返回的普通正文、推理字段、工具调用、usage 和完成原因均通过结构化事件进入同一事件流。所有事件继续经过现有的递归脱敏、序列校验和追加写入流程；`.echo/` 仍不得提交到 Git、复制进构建产物或进入双盲材料。

### 4.2 保存不等于展示

推理内容为了 Session 重放和 Provider 续接而保存，但默认不进入 CLI 输出：

- `run` 和 `chat` 的 Renderer 忽略推理事件；
- `--verbose` 也不显示推理原文；
- 普通最终答复仍只来自 assistant `content`；
- P2 可以消费同一事件流，但默认展示策略由 P2 文档另行约束；
- P1.5 不增加推理查看命令。

### 4.3 聚合而非逐 token 持久化

Provider 到 Agent Loop 的 `text_delta` 与 `reasoning_delta` 继续保持流式，以便及时响应取消，并为未来交互界面的实时展示保留边界；Session JSONL 不再把这些传输分片当作持久事实。

一次模型响应内，普通正文按到达顺序聚合，并至多追加一条 `model.text`；Provider-specific reasoning 同样聚合，并至多追加一条 `model.reasoning`。新写入方不得再持久化 `model.text_delta`。CLI 当前不直播逐字输出，因此这一变化不得改变 stdout/stderr、Step 分组或最终答复时机。

字符串字段必须按顺序原样拼接且不得 `trim`。`reasoning_details` 采用 all-or-nothing 归一化：整个非空数组必须严格由 `reasoning.text` 组成，允许键集合仅为 `type`/`text`/`format`/`index`，其非空拼接文本与 `reasoning` 或 `reasoningContent` 完全一致时才省略；details-only 时转为 canonical `reasoning`。任一项包含额外状态、特殊或未知类型、空文本，或拼接内容不一致时，整组数组及顺序必须原样保留。只有实际观察到至少一个推理字段时才追加事件，禁止持久化空 payload。

正常结束的正文事件使用 `{ text }`。Provider 流在完成前失败或被取消时，如果已经收到非空正文，必须先写入 `{ text, partial: true }`，再写入 `model.failed` 或 `turn.cancelled`。`finishReason=length` 表示 Provider 正常结束但输出受限，其限制语义仍由 `model.completed.finishReason` 与 Turn 终态表达，不额外标记 `partial`。

### 4.4 简洁状态展示

`/status` 的 Context 行只显示已用和上限：

```text
CONTEXT     | ~58K / 256K
```

不增加 `REASONING`、`OUTPUT`、`HIDDEN STATE`、`CONTINUATION` 或分项百分比。`~` 表示近似估算；详细 Context 解释留给 P2。

## 5. Provider 与模型契约

### 5.1 接收字段

OpenAI-compatible Client 必须保留以下允许字段：

```text
delta.content
delta.tool_calls
delta.reasoning
delta.reasoning_content
delta.reasoning_details
choice.finish_reason
usage.prompt_tokens
usage.completion_tokens
```

其他未知字段继续忽略，不能无边界保存整个 Provider 响应。跨 Provider 输入仍必须先验证为 JSON 可序列化的受限结构。

### 5.2 内部流事件

`ModelStreamEvent` 增加聚合推理事件：

```ts
interface ModelReasoningDelta {
  reasoning?: string;
  reasoningContent?: string;
  reasoningDetails?: readonly unknown[];
}

type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: ModelReasoningDelta }
  | { type: "tool_call_delta"; callId: ToolCallId; delta: string }
  | { type: "tool_call"; call: ModelToolCall }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "completed"; finishReason: ModelFinishReason };
```

该事件属于 Provider 到 Agent Loop 的结构化数据，不允许伪装成 `text_delta`。Provider 可以按流分片产生多个 `reasoning_delta`；Agent Loop 负责聚合，Session 不逐分片持久化。

### 5.3 Session 事件

`EchoEvent` 增加：

```ts
"model.text": {
  text: string;
  partial?: true;
};

"model.reasoning": {
  reasoning?: string;
  reasoningContent?: string;
  reasoningDetails?: readonly unknown[];
};
```

正常完成时的稳定事件顺序为：

```text
model.started
model.reasoning ?
model.text ?
model.tool_call *
model.completed
```

`model.text` 与 `model.reasoning` 必须关联当前 `turnId` 和 `stepId`，并在 `model.completed` 之前持久化。同一模型响应的 `model.text`、`model.reasoning` 各自至多一条；新写入方不得在同一响应中混用聚合正文与 `model.text_delta`。SessionStore 写入失败继续使用现有故障补偿和去重规则，不能产生重复正文、重复推理事件或重复 Turn 终态。

如果 Provider 流在完成前失败或被取消，Agent Loop 仍须在 `model.failed` 或 `turn.cancelled` 之前写入已经收到的聚合正文和 reasoning；没有收到对应字段时不写空事件。正文此时带 `partial: true`，reasoning 保持现有聚合结构。这样 Session 保存 Provider 已返回的事实，同时仍保持每类内容每次模型请求至多一个事件。

`model.text_delta` 继续保留在 Reader 和公共联合类型中，仅用于读取版本 1/2 及修订前已生成的版本 3 Session。投影、查询和 Renderer 必须同时接受两种表示；遇到同一 Step 同时包含 `model.text` 与 `model.text_delta` 的新日志应视为损坏，不得拼接后造成正文重复。

### 5.4 请求重建

`ModelMessage` 的 assistant 分支增加可选推理字段：

```ts
type AssistantModelMessage = {
  role: "assistant";
  content: string;
  reasoning?: string;
  reasoningContent?: string;
  reasoningDetails?: readonly unknown[];
  toolCalls?: readonly ModelToolCall[];
};
```

请求映射按字段来源恢复 wire shape：

```text
reasoning         -> reasoning
reasoningContent  -> reasoning_content
reasoningDetails  -> reasoning_details
```

包含工具调用的 assistant 消息必须同时携带同一步已保存的推理字段。推理字段、工具调用和对应工具结果在 Context 投影中是一个不可拆分组；不能保留工具结果却丢失对应 assistant 消息。

## 6. Agent Loop 终止语义

### 6.1 判定矩阵

Agent Loop 在持久化 `model.completed` 后，按下表决定是否执行工具或结束 Turn：

| 可见正文 | 完整工具调用 | finish reason | 结果 |
| --- | --- | --- | --- |
| 有 | 无 | `stop` | `completed / completed` |
| 任意 | 有 | `tool_calls` | 执行工具并进入下一 Step |
| 有 | 无 | `length` | `limited / output_limit`，保留部分正文 |
| 任意 | 有 | `length` | `limited / output_limit`，不得执行可能不完整的工具调用 |
| 无 | 无 | `length`，且观察到推理 | `failed / provider_error`，`PROVIDER_REASONING_BUDGET_EXHAUSTED` |
| 无 | 无 | `stop` | `failed / provider_error`，`PROVIDER_EMPTY_RESPONSE` |
| 任意 | 任意 | `content_filter` | `failed / provider_error`，`PROVIDER_CONTENT_FILTERED` |

Provider 使用 `stop` 返回完整工具调用的兼容行为，可以继续接受，但必须有完整、可解析且 ID 合法的工具调用。`unknown` 的兼容策略维持现状，但“无正文、无工具”仍必须失败。

### 6.2 新停止原因

`AgentStopReason` 增加：

```ts
"output_limit"
```

`output_limit` 使用 `status="limited"`，CLI 非交互退出码映射到现有限制类退出码 `6`。没有可用正文的推理预算耗尽属于 Provider 失败，继续使用退出码 `3`。

### 6.3 成功不变量

一个 Step 只有满足下列条件之一才可推进或完成：

```text
存在非空普通正文
或
存在完整、合法且允许执行的工具调用
```

推理字段、usage 或正常结束的 HTTP 流均不能单独构成成功证据。

## 7. Context 投影

### 7.1 当前策略保持

继续使用既有确定性策略：

1. 固定保留 System Prompt、Workspace Summary 和当前用户目标；
2. 从最近对话向前保留完整 Turn/Step；
3. 更旧内容压缩为规则式 Step 摘要；
4. 工具结果先按字符上限截断；
5. 摘要仍超预算时继续截断或排除。

P1.5 不引入 LLM 摘要或精确 tokenizer。

### 7.2 推理内容计入预算

推理字符串和 `reasoningDetails` 的安全 JSON 序列化结果使用现有近似估算器计入 assistant 消息成本。`ContextProjection.approximateTokens` 必须包含它们，避免 `/status` 与实际请求负载完全脱节。

一个历史 Turn 可以整体被窗口排除并由摘要替代；但仍被保留的 assistant 工具消息不得只删除其推理字段。当前 Turn 的推理、工具调用和工具结果若无法作为完整组装入预算，必须在发送下一次 Provider 请求前以可操作的 Context 错误失败，不能发送孤立工具结果。

### 7.3 失败轮次保留

`collectConversation` 必须从每个 `turn.started` 建立对话事实，而不能等待首个 `model.text`、旧 `model.text_delta` 或 `model.tool_call` 才创建 Turn。即使响应为空、受限、失败或取消，先前用户目标也必须进入后续 Context。

Context 投影按 assistant 消息消费聚合正文。旧 Session 的多个 `model.text_delta` 先按 Step 拼接；新 Session 的 `model.text` 直接作为同一消息正文。带 `partial: true` 的正文继续作为 Provider 已返回事实进入投影，并由对应失败或取消摘要明确其未完成状态。

失败或受限终态以简短结构化状态进入摘要，例如：

```text
Turn failed: provider reasoning exhausted the output budget; no tool call was executed.
```

不得把 `finalText=""` 的旧 Session 记录解释为任务完成。版本 2 Session 可以恢复，但不会凭空补造缺失的历史推理字段。

## 8. 预算调整

### 8.1 默认预算演进

| 配置 | P1 值 | P1.5 值 | P3.5 当前值 |
| --- | ---: | ---: | ---: |
| `context.maxApproxTokens` | 32,000 | 256,000 | 256,000 |
| `context.reservedOutputTokens` | 4,000 | 16,000 | 16,000 |
| `maxOutputChars` | 20,000 | 40,000 | 80,000 |
| `requestTimeoutMs` | 300,000 | 300,000 | 600,000 |
| `maxSteps` | 24 | 24 | 128 |
| `timeoutMs` | 120,000 | 120,000 | 300,000 |
| 等价工具调用限制 | 3 | 3 | 10 |

输入投影的理论预算为：

```text
256,000 - 16,000 = 240,000 approximate tokens
```

这些是 ECHO 的近似本地预算，不代表模型真实 token 数。当前目标 Provider/模型具有大于 256K 的上下文能力；切换到窗口更小的模型时，用户需要在产物配置中手动降低预算。P3.5 将执行预算放宽用于复杂扩展任务和演示录制，但仍保留有限上限、取消、策略判断与超时。

### 8.2 配置兼容

- 已显式配置的正整数继续优先于默认值；
- `reservedOutputTokens` 必须小于 `maxApproxTokens`；
- 不新增环境变量；
- 不新增 CLI token 参数；
- 配置向导生成的新配置写入当前 `maxOutputChars` 与上下文预算；其余省略字段由加载器采用当前内置默认值；
- 配置检查和帮助文本必须明确数值为 approximate。

## 9. CLI 行为

### 9.1 空响应失败

推理预算耗尽时不得渲染空白 `ECHO`，应显示：

```text
-- Turn failed ------------------------------------------------
REASON     | provider_error
DETAIL     | The model exhausted its output budget before
           | producing a visible response or tool call.
```

`run` 使用同一错误语义和退出码。提示可以建议重试、选择非推理模型或调整配置，但不得声称文件已修改或任务已解决。

### 9.2 部分输出受限

存在普通正文但 `finishReason=length` 时保留部分正文，并明确标记：

```text
-- Turn limited -----------------------------------------------
REASON     | output_limit
DETAIL     | The response may be incomplete.
```

不得显示 `VERIFIED`，除非确有此前成功的验证工具事件；即使存在此前验证，也不能把截断答复自动升级为 completed。

### 9.3 `/status`

仅修改 Context 行的默认预算和格式：

```text
CONTEXT     | ~58K / 256K
```

Session、模型、安全模式、最近 Turn 和验证摘要等现有字段保持。推理原文和推理分项不得进入 `/status`。

## 10. Session 版本与兼容

新增事件和停止原因属于公共事件契约变化。ADR-0006 冻结该变化，并将 `EVENT_SCHEMA_VERSION` 从 2 提升到 3。P1.5 尚未合入 `main`，因此聚合正文作为版本 3 的最终写入契约，不再额外制造版本 4。

兼容要求：

- 新 Session 写入版本 3；
- 版本 3 Writer 只写聚合 `model.text` 和 `model.reasoning`，不写 `model.text_delta`；
- 版本 3 Reader 接受并验证 `model.text` 与 `model.reasoning`；
- 版本 2 Session 继续可读、可查询和可恢复；
- Reader 继续接受版本 1/2 以及修订前本地产生的版本 3 `model.text_delta`；
- 同一 Step 的聚合正文与旧正文增量不得混用；
- 版本 2 不具备历史推理字段，不做不可验证的推理回填；
- 未知未来版本继续安全拒绝；
- Session 查询必须返回推理事件，但 CLI Renderer 默认忽略；
- 损坏的推理 payload 作为 Session 损坏处理，不能退化为普通文本。

如果实现验证表明维持双版本 Reader 会显著破坏现有存储不变量，必须在 ADR-0006 中记录替代迁移策略，不能在代码中静默改变。

## 11. 实施单元

### P1.5-0：ADR 与契约冻结

交付：

- ADR-0006；
- `ModelReasoning`、`model.reasoning`、`output_limit` 和版本 3 契约；
- P1.5 测试矩阵；
- 文档一致性测试先行。

该单元完成前不得并行修改 Provider、Agent Loop 或 Session 投影。

### P1.5-1：Provider 推理流

交付：

- OpenAI Client 保留三个允许的推理字段；
- Provider 聚合并生成单个 reasoning 事件；
- assistant 请求映射恢复相应 wire 字段；
- 流错误、取消、重试和非法结构保持现有边界。

### P1.5-2：Agent Loop 与 Session

交付：

- 新终止矩阵；
- `model.reasoning` 的持久化顺序和故障补偿；
- 普通正文内存聚合、单一 `model.text` 持久化和失败/取消 partial 保留；
- 版本 2/3 Session 读取与恢复；
- 空响应和部分输出不再产生错误成功。

### P1.5-3：Context 与预算

交付：

- reasoning 进入 assistant 投影和近似计数；
- 失败/受限用户目标不丢失；
- reasoning/tool/result 原子配对；
- P1.5 默认预算和配置向导同步。

### P1.5-4：CLI、文档与验收

交付：

- `run` / `chat` 空响应、受限和内容过滤展示；
- 简洁 `/status`；
- 受影响文档同步；
- 完整质量门与显式真实 Provider smoke。

## 12. 自动化测试矩阵

| ID | 行为 | 主要证据 |
| --- | --- | --- |
| RSN-01 | `reasoning` 字符串按顺序聚合 | Provider unit |
| RSN-02 | `reasoning_content` 按顺序聚合和回传 | Provider/request mapping unit |
| RSN-03 | 等价纯文本 `reasoning_details` 归一化为 canonical `reasoning`；特殊或不一致数组保持顺序和结构 | Provider/session unit |
| RSN-04 | 一次模型响应至多一个 `model.reasoning` | Agent Loop unit |
| RSN-05 | reasoning 不进入 `model.text_delta` 或 CLI | Provider/renderer unit |
| RSN-06 | reasoning 写入 JSONL 并可恢复投影 | Session/context integration |
| RSN-07 | reasoning + tool call + result 完整回传下一 Step | Agent Loop unit |
| RSN-08 | Provider 中途失败或取消时保留已返回 reasoning | Provider/Agent Loop unit |
| TXT-01 | 任意数量正文 delta 每次响应至多写一条 `model.text` | Agent Loop/session unit |
| TXT-02 | 新 Writer 不持久化 `model.text_delta` | Agent Loop/session integration |
| TXT-03 | 流失败或取消保存一条 `partial: true` 聚合正文 | Agent Loop unit |
| TXT-04 | 版本 1/2 与修订前版本 3 `model.text_delta` 继续恢复 | Session/context integration |
| TXT-05 | 同一 Step 混用聚合正文和正文增量安全拒绝 | Session/query/context unit |
| TXT-06 | CLI 对聚合正文的显示与原 stdout/stderr 契约一致 | Renderer/CLI integration |
| STOP-01 | reasoning-only + length 明确失败 | Agent Loop/CLI integration |
| STOP-02 | content + length 返回 limited 和部分正文 | Agent Loop/CLI integration |
| STOP-03 | tool call + length 不执行工具 | Agent Loop unit |
| STOP-04 | stop + empty 返回 `PROVIDER_EMPTY_RESPONSE` | Agent Loop unit |
| STOP-05 | content_filter 返回 Provider 失败 | Provider/Agent Loop unit |
| CTX-01 | 空/失败轮次用户目标进入下一 Turn | Context unit |
| CTX-02 | reasoning 计入 approximateTokens | Context unit |
| CTX-03 | reasoning/tool/result 不形成孤立消息 | Context unit |
| CFG-01 | 新默认值为 256K / 16K / 40K | Config unit |
| CFG-02 | 显式旧配置继续覆盖默认值 | Config unit |
| SES-01 | 版本 3 reasoning round-trip | Session unit |
| SES-02 | 版本 2 Session 继续可读和恢复 | Session integration |
| UX-01 | Chat 不再输出空白 `ECHO` | CLI integration |
| UX-02 | `/status` 仅显示 `~used / limit` | CLI unit/integration |

所有 CI 测试使用 Fake Provider 和合成 chunk，不访问网络、不读取 `.env.test`、不消耗付费 API。

## 13. 真实 Provider 验收

真实 Provider 验收只允许在本地显式运行，不进入 `pnpm check` 或 CI。验收至少覆盖：

1. 创建临时工作区和全新 Chat Session；
2. 请求分析并修复一个需要读取、修改和验证文件的问题；
3. 验证不再出现空白 `ECHO`；
4. 若预算耗尽，必须得到明确失败而不是 completed；
5. 若产生工具调用，Session 必须包含聚合 reasoning、工具调用和工具结果；
6. 使用 `--resume` 继续会话，确认 Provider 可接受重建后的消息；
7. 询问任务是否完成，回答必须与工具和验证事实一致；
8. 检查 Session、终端和扫描结果均不包含 API Key 或个人身份信息。
9. 检查每次模型响应至多一个 `model.text`、不含新写入的 `model.text_delta`，且正文长度增长不再线性放大事件信封数量。

真实模型文本不作为确定性断言；验收断言事件形状、终态、工具证据、恢复能力和无秘密泄漏。

## 14. 文档同步清单

P1.5 实现提交必须同步修改：

- `docs/decisions/0006-*.md`：冻结聚合正文、推理事件、Session 单一存储和版本策略；
- `docs/architecture.md`：Provider 数据流、Session 投影、Context 和终止条件；
- `docs/contracts.md`：模型消息、流事件、Session 事件、停止原因和版本；
- `docs/cli-ux.md`：reasoning 不展示、空响应失败、受限结果和 `/status`；
- `docs/testing.md`：P1.5 矩阵、真实 Provider 边界和覆盖证据；
- `docs/plans/p1-cli.md`：P1.5 状态与“事件不得保存思维链”条款；
- `docs/plans/p2-webui.md`：区分“Session 已保存推理事件”和“WebUI 默认不展示”；
- `README.md`：仅在用户可见配置或限制变化需要时更新。

实现与文档必须在同一任务中同步，不允许先合并代码、后补契约。

## 15. 风险与约束

- 正文和 reasoning 都会增大 Session 与输入上下文；P1.5 通过每响应每类至多一个事件控制事件信封成本，并用 256K 预算接受内容本身的成本；
- 聚合正文把崩溃窗口从“每个 delta 已持久化”扩大到“模型响应结束或捕获失败/取消时持久化”；当前 Agent Loop 已在内存中聚合最终正文，且失败/取消路径必须 best-effort 冲刷 partial，因此接受该权衡；
- 统一递归脱敏可能改变 Provider-specific 结构中的字符串；当前版本优先保持既有安全边界，真实 Provider smoke 必须验证恢复兼容；
- 近似 `字符数 / 4` 会低估中文和部分结构化数据；256K 是过渡本地预算，不宣称精确；
- `/model` 切换不会自动调整上下文窗口；较小窗口模型需手动降低配置；
- 版本 2 Session 缺少历史 reasoning，恢复只能保持已有事实，不能补造 Provider 状态；
- 保存 reasoning 不代表它是可靠解释或验证证据；任务完成仍以工具结果、文件变化和测试为准；
- Session 属于本地运行数据，不得提交、演示、公开发布或纳入双盲材料。

## 16. 完成定义

P1.5 只有同时满足以下条件才可标记完成：

- ADR-0006 和全部受影响文档已同步接受；
- 测试矩阵每行指向真实自动化证据，不含 `pending:`；
- `pnpm check`、`pnpm eval:offline`、`pnpm smoke:demo`、`pnpm smoke:artifact` 全部通过；
- Secret 与 identity scan 通过；
- `run` 和 `chat` 对 reasoning-only、empty、length、content_filter 使用一致语义；
- Session 版本 3 可重放 reasoning，版本 2 兼容行为有测试；
- 新 Session 每次模型响应至多一条 `model.text` 且不写 `model.text_delta`，旧增量 Session 仍可恢复；
- `/status` 只显示近似已用量和上限；
- 真实 Provider 本地 smoke 不再产生空白 completed Turn；
- 没有启动 P2 或 P3 范围。
