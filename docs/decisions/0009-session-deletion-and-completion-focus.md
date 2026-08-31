# ADR-0009：会话删除与 Turn 完成后的阅读定位

> 状态：Accepted
>
> 日期：2026-08-31
>
> 接受日期：2026-08-31
>
> 决策者：项目维护者
>
> 修订：[ADR-0007](./0007-local-web-console.md) 中“不提供 Session 删除”的范围条款

## 1. 背景

P2.5 实机验收表明两个局部缺口会明显影响控制台的日常可用性：长 Turn 完成时，工具摘要会把最终回答
挤出视野；Session rail 只能创建和恢复会话，无法清理无用记录。后者是不可恢复的持久化操作，不能只
增加一个前端按钮，也不能让浏览器直接删除 `.echo/sessions` 文件。

## 2. 决策

### 2.1 完成后的阅读定位

同一 Session 从 `running` 进入 `completed`、`failed`、`cancelled` 或 `limited` 时，Chat 内部滚动区
定位到最新 Turn 的起点，即该 Turn 的用户问题与回答区域开头。它不跳到整个 Session 顶部，也不改变
历史事件顺序。流式期间仍遵守既有尾随规则；切换 Session 或普通历史加载不伪造终态跳转。

### 2.2 单会话删除

Session rail 的每个条目提供具名删除按钮。所有删除都先显示模态确认：

- 空闲或终态 Session：确认后删除该 Session 的持久 JSONL 记录；
- 活动 Session：确认文案和按钮明确为“停止并删除”；服务端先取消活动 Turn，等待其终态事件完成
  持久化并释放活动状态，再删除 Session；
- 取消、终态等待或存储删除任一步失败时，保留 Session 和确认对话框并显示错误，不报告成功；
- 删除当前选中 Session 后重新读取首屏 Session 列表并选择下一条；没有剩余 Session 时进入空状态；
- 删除活动 Session 后关闭绑定该 Session 的 SSE，客户端按剩余选择重新建立正确的流。

删除经 `ApplicationService`、`ActiveTurnCoordinator` 和 `SessionRepository` 进入现有分层。存储层只
删除固定工作区 `.echo/sessions/<validated-session-id>.jsonl` 的普通文件，拒绝路径穿越、符号链接、
目录和删除开始后的新事件追加。它不是通用文件删除工具，也不扩大 Agent 的文件操作权限。

HTTP 使用 `DELETE /api/v1/sessions/:sessionId`、空 JSON 对象、同源认证和既有幂等键；成功返回是否为
活动 Turn 执行了停止步骤。浏览器不接收绝对路径或原始日志内容。

## 3. 选择理由

把终态回答定位在最新 Turn 起点，可在保留工具执行顺序的同时直接展示结果。删除由服务端协调而非前端
组合 cancel 与 delete，避免两个请求之间出现追加事件、半删除或错误成功提示。继续使用精确 Session ID
与固定 repository，能把破坏性范围限制在用户明确选择的一条会话记录。

## 4. 被考虑但未采用的方案

- 完成后滚到整页底部：长工具列表仍可能掩盖最终回答；
- 完成后重排回答和工具：会破坏真实事件顺序；
- 前端先调用取消再调用删除：存在竞态，且浏览器无法证明终态已持久化；
- 批量删除、清空全部或回收站：增加选择、恢复和索引生命周期，P2.5 不需要；
- 让 `delete_file` 工具删除 Session：绕过应用服务和活动 Turn 协调，也扩大模型可触发的破坏面。

## 5. 后果

- `ApplicationService`、`SessionRepository` 和 Web DTO 增加最小删除能力；
- 删除属于经过确认的控制台管理操作，不受 Agent safety mode 替代，也不会授予模型删除权限；
- 需要存储、协调器、API、transport、组件和浏览器回归测试；
- ADR-0007 其余固定工作区、单活动 Turn、无导出和无跨工作区管理边界保持不变。

## 6. 重新评估触发条件

- 需要回收站、批量删除、跨工作区索引或恢复已删除 Session；
- 需要在多个进程间协调同一工作区 Session；
- Session 存储从单文件 JSONL 改为共享数据库或远程服务。
