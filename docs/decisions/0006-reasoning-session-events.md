# ADR-0006：聚合模型内容进入单一 Session 存储

> 状态：Accepted
>
> 日期：2026-08-30
>
> 接受日期：2026-08-30
>
> 决策者：项目维护者
>
> 修订：[ADR-0003](./0003-p1-application-service-session.md) 中“事件不得保存思维链”的条款

## 1. 背景

P1 适配层只接收普通 `content` 和 `tool_calls`。推理模型可能只返回 Provider-specific reasoning 字段，并在输出预算耗尽时以 `finish_reason=length` 结束。Agent Loop 曾把“无正文、无工具调用”当作正常完成，产生空白 `ECHO` 和虚假成功。

后续请求对携带 `tools` 的推理模型需要回传已保存的推理字段。私有 sidecar 或第二套 continuation store 会增加生命周期和导出边界，当前阶段得不偿失。

首轮实现还沿用了 P0 的正文写入方式：每个 SSE `content` 分片都成为一条 `model.text_delta` Session 事件。CLI 和 Context 最终都会重新聚合这些分片，实测 3161 字符正文却生成 1756 条正文事件，使 JSONL 主要由重复事件信封膨胀。当前 CLI 不逐字直播，P2 历史和后续压缩也以消息或 Step 为语义边界，因此分片属于传输事实，不应继续作为默认持久事实。

## 2. 决策

现有工作区 Session JSONL 继续作为唯一事实来源。Provider 到 Agent Loop 继续流式产生 `text_delta` 与 `reasoning_delta`，Agent Loop 在内存中按到达顺序聚合。一次模型响应至多追加一条非空 `model.text` 和一条非空 `model.reasoning`；新 Writer 不再把 `model.text_delta` 写入 Session。`reasoning_details` 只在整个非空数组均为严格 `reasoning.text`、允许键集合限于 `type`/`text`/`format`/`index`，且拼接文本与已有字符串推理字段完全一致时省略；details-only 的同类数组转为 canonical `reasoning`。任何额外状态、特殊或未知类型、空文本及不一致内容都使整组数组原样保留。

Provider 流完成前失败或取消时，已收到的非空正文以单一 `{ text, partial: true }` 事件持久化，并位于失败或取消终态之前。正常结束（包括 `finish_reason=length`）不带 `partial`，限制原因由模型完成事件和 Turn 终态表达。新日志不得在同一 Step 混用 `model.text` 与 `model.text_delta`。

`EVENT_SCHEMA_VERSION` 从 2 提升到 3。P1.5 尚未合入 `main`，聚合正文直接成为版本 3 的最终 Writer 契约，不额外增加版本 4。版本 3 Reader 接受 `model.text` 与 `model.reasoning`，并继续读取版本 1/2 以及修订前本地产生的版本 3 `model.text_delta`。旧增量按 Step 聚合后投影；版本 2 不补造历史推理字段。未知未来版本、损坏 payload 或同一 Step 混用两种正文表示继续安全拒绝。

CLI Renderer 忽略 `model.reasoning`；`--verbose` 也不展示推理原文。`/status` 只显示近似已用量和上限。

Agent Loop 只有在存在非空普通正文或完整合法工具调用时才可推进或完成。推理字段、usage 或正常结束的 HTTP 流不能单独构成成功证据。

## 3. 选择理由

单一 JSONL 保持 Session 可重放，并满足推理模型跨工具步骤回传要求，同时避免 sidecar、索引和双生命周期。正文与推理都以响应级事件保存，使持久事实直接对应 assistant 消息，控制文件增长，并简化恢复、P2 时间线和后续压缩。默认不展示 reasoning 仍把保存与产品展示分开。

## 4. 被考虑但未采用的方案

- 私有 `continuations/` sidecar：增加删除、损坏和导出边界，当前版本不需要。
- 逐 token 持久化推理增量：Session 会快速膨胀。
- 继续逐分片持久化普通正文：只改善片级诊断和极小崩溃窗口，却显著增加长期 Session I/O 与体积。
- 把完整正文塞入 `model.completed`：失败或取消前没有稳定承载 partial 正文的位置，并让完成元数据与内容事实耦合。
- 为正文聚合提升到 schema 4：P1.5 尚未进入 `main`，Reader 兼容修订前本地 v3 即可，额外版本只增加项目复杂度。
- 在 CLI `/status` 中展示推理分项：日常命令过载，详细解释留给 P2。

## 5. 后果

- 公共事件契约增加 `model.text`、`model.reasoning` 和停止原因 `output_limit`；`model.text_delta` 仅保留为 Provider 流事件和旧 Session 读取兼容类型。
- Context 投影把推理字段计入近似 token，并保持 reasoning/tool/result 原子组。
- CLI 仍在响应边界展示聚合正文，stdout/stderr 与非 TTY 契约不变。
- 流式正文默认只存在于当前请求内存；片级到达时间若未来确有诊断需求，应进入显式 debug 旁路，而不是 Session 主事实。
- 默认本地预算调整为 256,000 / 16,000 / 40,000 字符级限制。
- 真实 Provider smoke 必须验证恢复后的消息仍可被 Provider 接受，且不泄漏秘密。

## 6. 重新评估触发条件

- Provider 要求无法放入三个允许字段的不透明 continuation 状态；
- 推理事件使 Session 体积不可接受；
- 产品需要跨进程精确重放每个 Provider 分片的到达时间；
- 需要按模型自动校准上下文窗口。
