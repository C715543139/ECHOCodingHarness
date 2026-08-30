# ADR-0007：固定工作区的本地 Web 控制台

> 状态：Accepted
>
> 日期：2026-08-30
>
> 接受日期：2026-08-30
>
> 决策者：项目维护者
>
> 修订：[ADR-0001](./0001-project-foundation.md) 中 P2 域名展示与范围条款；2026-08-30 明确顶栏范围、安全模式展示名，并排除导出会话

## 1. 背景

P0/P1 已提供可复用的 `ApplicationService`、可恢复 Session、版本化事件、统一安全策略与
OpenAI-compatible Provider。P2 需要增加 Web Chat、Session 历史和可解释性工作台，但不能在
浏览器侧复制 Agent Loop，也不能把本地代码执行服务扩展为任意目录可访问的全局 IDE。

公开产品中的“对话 / 轨迹”双视图、Session 导航和按需详情检查器可以作为交互形态参考；ECHO
不复制第三方代码、私有接口、目录结构或插件体系。ECHO 的 Session 以响应级聚合事件为事实，
不需要把 Provider 分片或原始思维链渲染为高密度调试时间线。

## 2. 决策

### 2.1 产品与工作区边界

`echo-harness web --workspace <path>` 启动一个仅服务该工作区的本地控制台。未指定
`--workspace` 时使用当前目录。工作区在启动时解析、固定并贯穿整个进程；浏览器不得提交、选择、
切换或枚举其他工作区路径。

WebUI 可以在固定工作区内创建、列出、恢复和浏览多个 Session。一个 Web 服务进程任意时刻只允许
一个活动 Turn，以避免同一工作区内的并发 Agent 修改。活动 Turn 期间可以只读浏览其他 Session，
但不能从其他 Session 提交新 Turn，也不能改变活动 Turn 所属 Session 的模型或安全模式。

P2 不提供 Session 删除、跨工作区搜索、受信工作区注册表或后台多 Turn。将来若需要全局控制台，
必须以新 ADR 定义工作区登记、授权、索引和进程隔离。

### 2.2 技术边界

- 前端使用 React 19、Vite 8 与 TypeScript；
- 本地服务使用 Fastify 5，静态资源由同一进程提供；
- 前端状态使用 React 自身状态与小型领域适配器，不引入第二套全局状态机；
- 样式使用 CSS Modules、CSS 自定义属性和语义设计 token；不引入整套视觉组件库或 Tailwind；
- 图标使用单一可访问图标库，状态同时保留文字，不以颜色或图标单独表达结论；
- HTTP 处理命令与查询，SSE 只传递服务器到浏览器的 Session 事件；
- Web adapter 只调用应用服务、配置服务和查询投影，不解析 CLI 文本或直接读取 JSONL。

Fastify 负责有限路由、请求体上限、内容类型、Schema 校验、统一错误映射和可注入集成测试；它不
拥有 Agent、工具、Policy 或 Session 语义。Vite 只负责前端构建，生产产物随 `dist/` 交付，不要求
用户运行开发服务器。

Phase A 必须把 `package.json` 的 Node 下限从 `22.0.0` 收紧为 `22.12.0`，并在
`package.json`/`pnpm-lock.yaml` 中锁定 React、Vite、Fastify 及相关插件的精确版本；这是 Vite 8
运行时要求的一部分，不改变项目继续采用 Node 22 的总体基线。

### 2.3 页面结构

主界面默认是两栏：Session 导航与当前视图。每个 Session 提供 `Chat` 和 `Trace` 两个视图。
顶栏只保留当前 Session 名称、`对话 / 轨迹` 与常驻连接状态。连接状态使用“绿点 + 已连接”或
“红点 + 未连接”，不得只依赖颜色；重连期间仍属于未连接，可以附加“正在重连”。工作区脱敏名称
只在侧栏；当前模型、安全模式和近似上下文用量的固定摘要只在输入区，历史 Context 事实仍可在
Trace 与 Inspector 中查看。安全模式展示名与领域值相同：`safe`、`balanced`、`auto`。
Session 行使用文字状态，不加状态图标。选中工具、策略、Context 或验证事件时，右侧按需展开
结构化 Inspector，形成临时第三栏；未选中记录时不保留空白第三栏。P2 不提供导出会话。

`Trace` 不绘制图形时间轴。它按持久事实的实际顺序，以 Turn/Step 分组展示用户、上下文、代理、
工具、策略、审批、验证和 Turn 终态。流式正文只更新同一条进行中的代理记录；历史和刷新只读取
聚合 `model.text` 等 Session 事实，不重放逐 token 打字过程。

当前事件能表达 ask/deny 的部分理由，但 policy allow 尚无完整、稳定的 Explain 事实。P2 阶段 A
必须让 `PolicyDecision` 为每种结论携带稳定 rule ID，并把 rule ID 与脱敏原因持久化到对应授权、审批
或拒绝事件；旧 Session 缺失时显示“旧会话未记录”，不得由前端从命令字符串补算。兼容字段使用
可选 Reader、新 Writer 必填，不为这项向后兼容扩展单独提升 Session schema。

设置使用可扩展的左侧导航壳，P2 只注册 `Provider` 页面。Provider 页面复用 CLI 背后的配置服务
和 Schema，允许编辑 Base URL、模型目录模式、手动模型与默认模型；API Key 只显示是否由
`ECHO_API_KEY` 配置，秘密值不得进入浏览器。

### 2.4 本地访问保护

服务只监听随机或显式端口的 `127.0.0.1`，并只接受启动时确定的精确 `Host` 与同源 `Origin`。
默认不发送 CORS 许可头。启动时生成至少 256 bit 的一次性 bootstrap token；CLI 通过 URL fragment
把它交给自动打开或 `--no-open` 打印的页面。fragment 不进入 HTTP 请求。

前端以一次 POST 兑换进程级、`HttpOnly`、`SameSite=Strict`、无持久过期时间的认证 Cookie，随后
立即从地址栏移除 fragment；bootstrap token 只能成功使用一次。所有 `/api/v1/**` 请求均需有效
Cookie，改变状态的请求还必须通过精确 Origin、Host、JSON content-type 和幂等键校验。页面、日志和
Session 不得保存 bootstrap token 或 Cookie。

静态响应设置严格 CSP、`frame-ancestors 'none'`、`X-Content-Type-Options: nosniff` 和禁止缓存敏感
API 响应的头。SSE 断开、页面关闭或刷新不触发批准、取消、重试或重新执行。

### 2.5 实时与幂等

每个进程级认证 Cookie 同时最多保持一个 Session SSE，因此多个标签页也共享这一限制：存在活动
Turn 时绑定其 Session；没有活动 Turn 时可以绑定当前选中 Session。活动 Turn 期间浏览其他历史
Session 使用普通 GET，不切断活动流。SSE 的 `id` 使用所绑定 Session 的单调事件序号；客户端通过
`Last-Event-ID` 或 `after` 恢复。
服务器先从 Session 查询补齐已提交事件，再进入直播。若请求位置早于可提供窗口，返回显式
`resync_required`，客户端重新获取聚合快照，不重新提交 Turn。

创建 Session、提交 Turn、取消、审批、改变 Session 运行时和写配置都携带客户端生成的
`requestId`。method、规范化 route、requestId 和请求指纹相同的重放必须返回第一次结果；同一键
对应不同请求指纹时稳定冲突，不得产生第二次工具副作用。审批仍精确绑定 Session、Turn、
`toolCallId` 与 `approvalKey`。

## 3. 选择理由

固定工作区保留了 WebUI 的完整会话工作流，同时避免浏览器目录浏览、任意路径授权、跨工作区
Session 索引和多工作区配置解析。进程级单活动 Turn 使并发约束与 ECHO 的单智能体定位一致，也
降低同一仓库并发写入的风险。

Chat/Trace 双投影和按需 Inspector 可以展示 ECHO 的 Context、Harness 与 Orchestration，而不把
原始事件洪流或隐藏推理误当作可解释性。共享应用服务与配置服务保证 CLI 和 WebUI 的行为不会
分叉。

## 4. 被考虑但未采用的方案

- 页面选择任意工作区：扩大本地文件访问面，并引入目录浏览、授权与索引生命周期。
- 每个 Session 独立运行一个 Turn：同一工作区可出现并发副作用，首版收益不足。
- 只显示启动时单个 Session：实现简单，但 WebUI 会退化为 CLI 查看器。
- 原始 JSONL 或逐 chunk 轨迹：信息密度过高，也把存储实现暴露成公共 UI 契约。
- 图形时间概览：对 ECHO 的规模和展示目标不是必要信息，增加交互与无障碍成本。
- 浏览器直接写配置文件或调用 CLI：会重复解析、错误和锁语义；应调用共享配置服务。
- URL 查询参数长期携带 token：容易进入历史、日志和复制内容。
- WebSocket：P2 的客户端命令均可用普通 HTTP，单向直播使用 SSE 更简单。

## 5. 后果

- P2 必须新增 Web DTO 与投影层，不能直接序列化内部类或全部 `EchoEvent` payload；
- P2 必须补齐稳定 Policy rule ID 与授权原因的持久事实，并保持旧 Session 可读；
- `ApplicationService` 需要一个进程级活动 Turn 仲裁器，现有每 Session 保护仍保留；
- 配置写入逻辑需从 CLI 向导中抽成共享服务，并保持原子替换与严格校验；
- 构建顺序必须使 Vite 静态资源进入最终 `dist/web/`，且 tsup 不清除它；
- CI 需要浏览器端组件测试、Fastify 注入测试和 Windows Chromium 端到端 smoke；
- P2 文档与实现状态必须同步，未实现前不得宣称 `echo-harness web` 可用。

## 6. 重新评估触发条件

- 需要从一个服务管理多个工作区；
- 需要多个 Session 并发运行或后台 Agent；
- 需要远程访问、多用户认证或域名部署；
- SSE 无法满足已验证的实时与恢复需求；
- 产物目录不可承载静态资源或持久配置。
