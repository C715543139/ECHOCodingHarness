# P2.5 WebUI 优化与问题记录

> 状态：In progress
>
> 版本：0.1
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
