# P2.5 WebUI 优化与问题记录

> 状态：Accepted
>
> 版本：0.9
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

## WEB-004：P2.5 细节验收修正

### 问题

浅色重构通过后，桌面实测仍发现侧栏宽度、工作区名称可读性、顶栏对齐、页面滚动所有权、Inspector
横向溢出、设置模型列表和“回到最新”提示不够一致。

### 决定与实施

- 桌面 Session rail 默认宽度为 `17.5rem`（280 px），可在 208–420 px 内拖动；分隔条支持左右
  方向键、`Home` / `End`，双击恢复默认值。响应式单列布局不显示分隔条；
- 工作区行使用“当前工作区”标签，不显示文件夹图标；“会话”分组标签与“当前工作区”共用排版。
  工作区脱敏名称保持 `--echo-text-lg`，具体 Session 标题改用与“新会话”按钮相同的
  `--echo-text-base`；长工作区名称仍可换行并在悬停时显示完整脱敏名称。Web DTO 继续禁止 `/`、
  `\` 和盘符，绝对路径不得为解决显示问题而进入浏览器；
- 工作区名称在侧栏可用宽度内居中显示；
- 桌面顶栏使用三列布局，将“对话 / 轨迹”稳定置中，连接状态保持右对齐；
- `html`、`body`、`#root` 与主壳固定为视口高度并隐藏文档级溢出；窄屏单列布局也保持在主壳内，
  滚动所有权只属于 Chat、Trace、Session 列表、Inspector 和设置内容等明确区域。Chat/Trace 只开放
  纵向滚动，禁止长内容产生页面级或内容区横向滚动；
- 桌面 Inspector 默认宽度为 `19rem`（304 px），可在 256–480 px 内调节；分隔条支持拖动、左右
  方向键、`Home` / `End` 和双击复位，响应式单列布局隐藏分隔条。Inspector 外壳不滚动，内容层
  只开放纵向滚动；字段、代码、diff 和关联 ID 自动换行，不保留横向滚动条；
- 自动发现与手动维护的模型使用最高 `11rem` 的独立键盘可聚焦滚动列表，不再随模型数量撑高设置卡；
- 输入区模型与安全模式选择器固定为 `2rem` 高、取消垂直内边距并使用原生正常行高，保持文字垂直
  居中；
- Chat 与 Trace 的尾随恢复统一为“回到最新”浮层按钮。按钮高度不低于 `2.25rem`，距底部
  `1.5rem`；Chat 位于输入区上方，Trace 位于列表底部。浮层容器不绘制额外背景，也不占用内容
  布局高度。
- 选中活动 Turn 所属 Session 时只显示“当前 Session 正在运行”的提示条，不重复显示“另一会话正在
  运行”；后者只用于浏览非活动 Session。`turn.terminal` 必须使用终态后的活动 Turn 快照投影，并在
  客户端无论当前选中哪个 Session 都清除旧的全局运行限制，不要求刷新或切换视图；
- Chat 阅读区使用独立于 Trace 的响应式留白，桌面端四周至少 `--echo-space-6`，水平方向可随视口
  增长至 `4rem`；相同的 Turn 状态与 stop reason 只显示一次，例如成功终态显示 `completed`，不显示
  `completed · completed`。不同 stop reason 仍保留在状态后方；
- Chat 主信息采用最大 `56rem` 的居中内容列；用户气泡、模型正文、工具摘要、审批/运行提示与输入卡
  共用同一水平轴。宽度不足时内容列随主视图收缩，窄屏保持既有紧凑边距；Trace 与 Inspector 不套用
  该宽度；
- 聚合模型正文按 [ADR-0008](../decisions/0008-safe-web-markdown.md) 渲染 CommonMark 与 GFM；用户消息
  保持纯文本。原始 HTML 被丢弃，图片只显示 alt 占位说明，链接协议受限且在隔离的新标签页打开；

### 验收证据

- `tests/unit/web/session-rail.test.tsx` 与 `tests/unit/web/states.test.tsx` 覆盖两侧栏的拖动、键盘边界
  和恢复默认宽度；
- `tests/unit/web/chat-stream.test.tsx` 与 `tests/unit/web/inspector.test.tsx` 覆盖统一文案、浮层位置和
  恢复尾随，并守护成功终态文案去重、模型 Markdown 语义和不可信内容边界；
- `tests/e2e/web/session-flow.spec.ts` 覆盖桌面拖动、两组侧栏文字层级、文档无整体滚动和模型列表独立
  滚动样式，以及工作区名称居中、Chat 阅读区响应式留白和内容列/输入卡同轴；
  `tests/e2e/web/markdown.spec.ts` 覆盖浏览器语义渲染、用户纯文本和远程图片零请求；
  `tests/e2e/web/trace-large-session.spec.ts` 覆盖 Inspector 宽度边界和无横向溢出；
- `tests/unit/web/composer.test.tsx` 覆盖当前/其他 Session 的运行提示；
  `tests/integration/web/sse.test.ts` 与 `tests/unit/web/http-transport.test.ts` 覆盖终态 SSE 在当前或其他
  Session 视图下即时清除活动能力；
- 完整 `pnpm check` 与 `pnpm test:web:e2e` 作为最终质量门。
