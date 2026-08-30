# P2.5 WebUI 优化与问题记录

> 状态：In progress
>
> 版本：0.2
>
> 最后更新：2026-08-31

本文记录 P2 验收后发现的 WebUI 体验问题、当前决定和后续候选方案。未经单独任务批准，不在问题
记录阶段改变既有认证、安全或并发契约。

## WEB-001：重复打开 CLI bootstrap URL 显示未连接

### 现状

`echo-harness web` 输出的 URL 携带一次性 bootstrap token。首次成功兑换后：

- 再次打开原始 URL 会重复提交已消费 token；
- 同一认证 Cookie 同时只允许一条 Session SSE，第二个 live 标签页会收到
  `409 STREAM_ACTIVE`；
- 页面将认证或 SSE 失败投影为“未连接”。

一次性 token 和单 SSE 是 P2 的安全与资源所有权设计；“重复打开后只看到未连接且没有解释”是
可用性问题。

### P2.5 当前决定

暂不修改 bootstrap、Cookie、SSE 所有权或前端重连逻辑。CLI 在输出连接 URL 后追加说明：

```text
Note: This bootstrap URL is single-use. Reopening it or opening a second live tab may show disconnected; restart this command for a new browser connection.
```

验收要求：

- 默认打开与 `--no-open` 都输出同一说明；
- URL 仍保持原样，现有 smoke 可继续解析；
- 说明不得包含 token、Cookie、绝对路径或 Provider 信息。

### 后续候选方案（未实施）

1. 已有有效 Cookie 时忽略重复 fragment，并立即清理地址栏；
2. 使用 `BroadcastChannel` 协调多标签页，由一个标签页持有 SSE 并广播有界投影；
3. 增加显式生成新 bootstrap 凭据的本地命令或受保护 API。

采用任一方案前必须同步修订 [ADR-0007](../decisions/0007-local-web-console.md)、
[Web API](../web-api.md)、安全模型及多标签页集成测试。

## WEB-002：SSE 所有权释放存在时序竞态

### 现状

`tests/integration/web/sse-ownership.test.ts` 在客户端销毁请求后立即重连，偶发得到
`409 STREAM_ACTIVE`。服务端在观察到 socket close 时才释放租约，这个观察晚于客户端自身的
`close` 事件，因此“销毁后立刻可重连”是测试的错误假设，不是服务端契约破坏。

### P2.5 决定

服务端所有权模型不变。测试改为在 2 秒内有界重试重连，其余断言（心跳、无 `id:` 前缀、单流
互斥）保持原样，使该用例确定性通过而不放宽契约。

## WEB-003：WebUI 偏离原始 UI 示意图

### 现状

P2 交付的控制台使用深色主题、药丸式视图切换、纯文本消息列表与分散的输入控件，与规划期的浅色
示意图在配色、层级与控件形态上明显不一致。

### P2.5 决定与实施

按 U0–U5 分阶段重构，只改视觉与布局，不改 Web API、DTO、能力投影、审批语义或键盘契约：

- U0：`styles/tokens.css` 重写为唯一浅色语义调色板，权威值记入
  [web-ui.md §3.1](../web-ui.md)；不提供深色主题与主题切换；
- U1：主壳网格、Session rail（品牌块、工作区行、分组标签、卡片式条目、可折叠开关）与顶栏
  （标题 + 下划线标签页 + 连接状态）；
- U2：用户消息右侧气泡（保留屏幕阅读器标题）、Agent 无框正文、状态色左边框工具卡、带图标的
  运行提示条、单卡片输入区内联模型/安全模式/上下文用量/发送；
- U3：Trace 增加装饰性列头与三列加次行摘要的行布局，保留 4.5rem 两行行高与既有虚拟化常量；
  Inspector 改为具名图标关闭与标签值网格；
- U4：Provider 设置改为分组卡片、分段单选与等宽只读模型列表，API Key 仅显示状态；
- U5：完整质量门、重拍权威截图、删除 `docs/plans/p2-webui-demo/` 三张示意 PNG 并修正
  [验收矩阵](./p2-acceptance-matrix.md) P2-4-11 的证据描述。

约束：语义色只作为文字状态的补充；所有图标为 `aria-hidden` 装饰或具备可访问名称；行为契约由
既有单元、集成与 Playwright 用例守护，重构期间未放宽任何断言。
