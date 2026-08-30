# P2 本地 WebUI 与可解释性工作台计划

> 状态：Accepted plan（阶段 A 已实现；B3 Trace 投影与 Inspector 已落地，B1/B2/B4/C 尚未集成）
>
> 版本：1.5
>
> 最后更新：2026-08-30

## 1. 目标

P2 在 P0/P1/P1.5 已交付的 CLI、应用服务、Session 查询、事件聚合、配置和安全策略之上，增加一个
固定工作区的本地 Web 控制台。用户可以在浏览器内新建和恢复 Session、进行 Chat、处理审批、切换
Session 模型与安全模式、检查结构化执行记录，并维护 Provider 非秘密配置。P2 不提供导出会话。

P2 不重新实现 Agent。CLI 与 WebUI 必须共享 Provider、Agent Loop、Context Projector、工具注册表、
安全策略、配置服务、Session repository 与 `ApplicationService`。

权威文档：

- 架构与安全决策：[ADR-0007](../decisions/0007-local-web-console.md)；
- HTTP、SSE 与 DTO：[web-api.md](../web-api.md)；
- 页面、交互与无障碍：[web-ui.md](../web-ui.md)；
- 核心领域契约：[contracts.md](../contracts.md)；
- P1.5 聚合 Session 事实：[ADR-0006](../decisions/0006-reasoning-session-events.md)。
- 需求—测试—证据映射：[p2-acceptance-matrix.md](./p2-acceptance-matrix.md)。

若实现发现上述文档冲突，应先修订 ADR/契约与验收矩阵，再修改代码，不允许建立第二套临时语义。

## 2. 产品边界

P2 分为四个交付包：

1. **P2-1：本地 Web 服务、配置服务与 API**；
2. **P2-2：Web Chat、Session 历史与 Provider 设置**；
3. **P2-3：按序事件记录与结构化 Inspector**；
4. **P2-4：体验、测试、产物和最终验收**。

P2 的产品语义是“针对启动工作区的图形化 Coding Agent 控制台”：

- 工作区在服务启动时固定，页面内不可选择或切换；
- 固定工作区内可以创建、列出、恢复和浏览多个 Session；
- 整个 Web 服务进程同时只允许一个活动 Turn；
- 活动 Turn 期间可只读浏览其他 Session，但不可并发提交或修改运行时；
- TUI、远程服务、域名部署、多用户、Skill、插件、MCP、多智能体、子代理和导出会话均不属于 P2。

源码与测试落点固定为：

```text
src/web/server     Fastify adapter、认证、路由与 DTO
src/web/client     React/Vite 页面
tests/unit/web
tests/integration/web
tests/e2e/web
```

A3/A4 不得另起包名或第二套目录。生产静态资源仍写入 `dist/web/`。

桌面 IA 临时视觉参考见 [p2-webui-demo.md](./p2-webui-demo.md)。图只确认布局气质；安全模式、默认
上下文上限、连接状态、发送可用态、Session 文字状态和 Inspector 区块以
[web-ui.md](../web-ui.md) 与 [web-api.md](../web-api.md) 为准。这些图是非最终视觉稿，P2 完成后必须删除整个
`docs/plans/p2-webui-demo/` 目录及说明文档，并去掉所有引用。

## 3. 技术基线

### 3.1 前端

- React 19、Vite 8、TypeScript strict；
- CSS Modules、CSS 自定义属性与语义设计 token；
- React 本地状态与领域适配器，不引入 Redux 等第二套状态机；
- 不引入完整组件库或 Tailwind；使用原生语义控件和一套可访问图标；
- Vitest、Testing Library 与 Playwright Chromium 负责组件和浏览器流程测试。

### 3.2 服务端

- Fastify 5 作为有限的 loopback Web adapter；
- JSON Schema 负责请求/响应边界校验；
- HTTP 处理查询与命令，SSE 处理单向 Session 直播；
- 前端静态资源和 API 由同一进程、同一 Origin 提供；
- Web adapter 不持有 Agent 决策、Policy 判断或 JSONL 修复逻辑。

### 3.3 构建

生产构建先生成 Node CLI/库，再将 Vite 静态资源写入 `dist/web/`。最终包仍以 `dist/` 为唯一交付
目录，用户不需要单独安装或启动开发服务器。Phase A 同步把 Node 运行时下限收紧为
`>=22.12.0 <23`，并通过 `package.json` 与 `pnpm-lock.yaml` 固定上述 Web 依赖的精确版本。

## 4. 启动与生命周期

```powershell
echo-harness web [--workspace <path>] [--port <port>] [--no-open]
```

- 未提供 `--workspace` 时使用当前目录；
- 只监听 `127.0.0.1`，默认由系统选择空闲端口；
- 默认打开服务器实际生成且已验证的 loopback bootstrap URL（可注入 opener，测试不打开真实浏览器）；
  `--no-open` 不调用 opener，只打印同一地址；artifact smoke 使用 `--no-open`；
- 启动输出实际端口和脱敏工作区名，不输出 API Key、Cookie 或绝对个人路径；
- 关闭时立即拒绝新状态改变请求，取消唯一活动 Turn，最多等待 10 秒清理；
- 清理完成退出 0，终态或资源清理失败以非零码报告。

## 5. P2-1：本地 Web 服务、配置服务与 API

### 5.1 目标

建立经过认证、验证、脱敏和可测试的本地适配层，让浏览器只通过稳定 DTO 使用现有领域能力。

### 5.2 工作项

1. 新增 Web DTO、错误码和序列化边界；
2. 补齐每种 Policy 结论的稳定 rule ID 与授权原因持久事实，旧 Session 保持可读；
3. 从 CLI 配置向导抽出共享配置读写服务，保持 artifact-root、Schema、原子写入和错误语义；
4. 实现 Fastify 生命周期、静态资源、精确 Host/Origin、CSP 和请求体上限；
5. 实现一次性 bootstrap token 与进程级 `HttpOnly` Cookie；
6. 实现 bootstrap、Provider、Session、Turn、取消、审批和 Trace API；不实现导出 API；
7. 实现进程级单活动 Turn 仲裁；
8. 实现每个进程级认证 Cookie 一个 Session SSE；活动 Turn 时保持绑定其 Session，并支持 seq 补齐、
   去重和 `resync_required`；
9. 为状态改变请求实现 `requestId` 幂等记录；
10. 把内部错误映射为稳定、脱敏的 Web 错误，不返回堆栈或磁盘路径。

### 5.3 完成标准

- API 与 [web-api.md](../web-api.md) 一致；
- 重复 Turn、取消、审批和保存不会产生第二次副作用；
- 浏览器无法提交工作区根路径；
- API Key 与 bootstrap/Cookie 不进入 DTO、Session 或日志；
- Fastify 注入测试覆盖认证、安全头、Schema、错误和生命周期。

## 6. P2-2：Web Chat、Session 历史与 Provider 设置

### 6.1 主界面

默认两栏：Session rail 与当前 Session 主视图。Session 内提供 `Chat` / `Trace`。Inspector 只在
选中结构化详情时展开，不保留空白第三栏。顶栏只保留 Session 名称、`对话 / 轨迹` 与常驻连接状态。
连接状态使用“绿点 + 已连接”或“红点 + 未连接”；工作区名只在侧栏；当前模型、安全模式和上下文
用量的固定摘要只在输入区，历史 Context 详情仍由 Trace/Inspector 展示。

Session rail 支持：

- 新建 Session；
- 分页列出固定工作区 Session；
- 恢复并切换 Session；
- 显示脱敏标题、更新时间、模型，以及不加图标的文字状态；
- 活动 Turn 期间浏览其他 Session，并明确禁用并发提交。活动 Turn 时仍可新建，但新 Session
  输入区禁用并说明“另一会话正在运行”。

P2 不实现删除、fork、跨工作区搜索或批量管理。

### 6.2 Chat

- 显示用户输入、聚合 `model.text`、工具摘要、审批和 Turn 终态；
- 当前直播使用 SSE 更新同一条记录，刷新只读聚合 Session 事实；
- 固定输入区提供模型、`safe` / `balanced` / `auto`、只读上下文用量、发送按钮，以及运行提示条上的
  停止按钮；发送与停止是两个控件，运行时发送禁用；
- 活动 Turn 期间禁止切换模型/安全模式和提交其他 Session；
- 审批提供拒绝、仅本次、本 Session 三种明确动作；
- 用户上滚后暂停自动跟随，使用“有新内容”恢复尾随；
- Provider/连接/认证错误与 Agent 失败分开显示。

### 6.3 Provider 设置

设置采用可扩展的左侧导航形式，但 P2 只包含 `Provider` 页面：

- Base URL；
- 自动发现或手动模型目录，二选一；发现结果是只读列表，不作为当前 Session 模型选择器；
- 默认模型；当前 Session 模型只在输入区修改；
- API Key 是否由环境变量配置；
- 与 CLI 共用校验和保存服务。

API Key 不提供输入、读取、复制或清除。自动发现是显式动作且不自动保存。活动 Turn 存在时设置
只读。

### 6.4 完成标准

- 无 Session、新建、恢复、运行、审批、断线、失败和取消状态均有明确 UI；
- 顶栏常驻的“已连接 / 未连接”与本地 API、所选 Session 的认证 SSE 状态一致，文字与状态点同时存在；
- CLI 与 WebUI 对模型、安全模式、审批和配置产生同一领域结果；
- 页面刷新不产生重复 Turn，不显示 reasoning，不丢失已聚合正文；
- Session 列表和历史使用 cursor 分页，大量数据不阻塞输入。

## 7. P2-3：按序事件记录与结构化 Inspector

### 7.1 事件记录

Trace 不使用顶部图形时间线。记录按 Session seq 从旧到新排列，并按 Turn/Step 轻量分组。固定类型：

```text
用户 · 上下文 · 代理 · 工具 · 策略 · 审批 · 验证 · Turn
```

每行显示事件类型、名称/动作、状态、时间、可用耗时、参数摘要和结果摘要。Provider chunk、推理 chunk、
内部重试和原始 HTTP 事件不形成 UI 行；直播更新稳定 record ID。

### 7.2 Inspector

选中记录后展示结构化的元数据、参数、结果、限制和关联记录。不同类型继续复用同一 Inspector 壳：

- Context：预算、数量和裁剪原因；
- Policy：decision、rule ID、原因和最终是否执行；
- Tool：脱敏参数、结果、状态和 bounded output；
- 文件变化：相对路径和 bounded diff；
- Verification：真实 `run_command`、退出码、耗时和截断；成功只表示命令退出码为 0；
- Turn：终态、stop reason、Step/工具数和实际证据。

默认不展示 `model.reasoning`，也不把它当作完成或验证证据。前端不得根据命令文本自行判断 Policy。

### 7.3 明确不做的导出

P2-3 不实现 Session Markdown/JSON 导出或对应下载入口。

### 7.4 完成标准

- Trace 顺序在直播、刷新、补页和恢复后稳定；
- 长 Session 分页并虚拟化；上滚时不被新事件抢夺位置；
- Inspector 内容与选中 record ID 精确对应，并按契约投影元数据、参数、结果、限制与关联；
- `Verified` 只能由实际 `run_command` 终态产生，且只表示退出码成功；无证据显示 `Not verified`。

## 8. P2-4：体验、测试、产物与验收

### 8.1 体验与无障碍

- 空、加载、运行、等待审批、断线、resync、失败、取消、受限和完成状态齐全；
- 桌面两栏、按需 Inspector；窄屏使用抽屉/单列但不复制状态；
- 键盘可完成新建、切换、发送、停止、审批、Trace 检查和设置保存；
- 焦点可见，模态焦点可恢复，流式内容不逐 token 播报；
- 颜色不是唯一状态线索，200% 缩放和 reduced motion 可用；
- 双盲界面不显示姓名、学校、账号、邮箱或个人绝对路径。

### 8.2 自动化

至少覆盖：

- 配置服务、Web adapter 与应用服务集成；
- API Schema、Cookie、Host、Origin、CORS、CSP 和工作区隔离；
- 进程级单活动 Turn 与 Session 切换；
- SSE 顺序、补齐、重复、断线和 resync；
- Turn、取消和审批竞态及幂等；
- React 组件、状态投影、键盘和焦点；
- Playwright Chat、审批、Trace 和设置关键流程；
- 大型 Session 分页/虚拟化和直播滚动；
- 秘密、身份、绝对路径与 reasoning 泄露扫描；
- Windows 构建产物从非仓库目录启动的 Web smoke；
- P0/P1 `run`、`chat`、`config` 回归。

CI 只使用 Fake Provider，不设置真实 API Key 或调用付费服务。真实 Provider 只在本地受控验收中运行。

### 8.3 构建产物

最终产物支持：

```text
echo-harness run
echo-harness chat
echo-harness config
echo-harness web
```

`dist/web/` 与 Node 入口一起交付。产物 smoke 必须从不含源码、`node_modules` 和仓库配置的临时目录
启动，并验证静态页面、API 鉴权、Session 创建和优雅关闭。

## 9. 实施顺序与并行边界

### 阶段 A：契约与骨架

1. **A0：依赖与构建骨架（已实现）**（先串行）。已锁定 React 19、Vite 8、Fastify 5 的精确版本；
   Node 下限已收紧为 `>=22.12.0 <23`；[AGENTS.md](../../AGENTS.md) 已同步；`src/web/server`、
   `src/web/client`、分层测试目录、`pnpm test:web` 与写入 `dist/web/` 的 `pnpm build:web` 已建立。
   A0 只交付可验证的最小壳层，不声称 Fastify API、产品页面或浏览器流程已经实现。
2. **A1：Web 契约与 Policy Explain 事实（已实现）**。已冻结全部跨 HTTP/SSE 边界 DTO 的运行时 JSON Schema
   （Page/ApiResponse 由统一工厂生成，长度与数组上限集中定义）、错误码、幂等终态语义和三层
   Policy Explain 事实。`PolicyDecision` 携带稳定 `ruleId`，新 Writer 写入授权/审批/拒绝事件，旧 Session
   缺少字段时按可选兼容读取，不提升 Session schema。DTO 脱敏约束已冻结。B3 已落地 `projectTrace`
   投影器，P2-1-05 仍因 HTTP 装配未接而保持 Partial。本任务不实现 HTTP 路由或页面。
3. **A2：共享 Provider 配置服务（已实现）**。已抽出 CLI/Web 共用的读取、严格校验、显式发现、
   写锁与原子写入。Web 使用受限 Provider merge（`saveProviderSettings`），CLI wizard 使用完整
   校验替换（`replacePersistentConfig`）；API Key 仍只来自环境变量。本任务不实现 HTTP 路由。
4. **A3：Fastify 服务骨架（已实现）**。已落地固定工作区生命周期、bootstrap 认证、Host/Origin 防护、
   静态资源和可注入路由测试。不实现完整业务路由。
5. **A4：React 页面骨架（已实现）**。已落地设计 token、Session/Chat/Trace 主壳、Provider 设置导航壳
   和组件测试环境；顶栏、侧栏和输入区按 [web-ui.md](../web-ui.md) 落位。使用 Fake transport，不连接
   真实 API。
6. **A5：Phase A 集成门禁（已实现）**。已统一 Fastify 路由装配、React 根组件、package scripts、
   `dist/web/` 构建顺序与 CI；`pnpm test:web` 与 `pnpm smoke:web-artifact` 进入质量门。业务
   Session/Turn API 与 Playwright 流程仍待阶段 B。

A0 完成后 A1 与 A2 可并行。A1/A2 契约冻结后 A3 与 A4 可并行。Web DTO 与配置服务属于共享边界，
阶段 A 完成前不得并行实现相互竞争的私有类型。

### 阶段 B：可并行核心

- B1：Session/Turn/审批 API、单活动 Turn 与 SSE；
- B2：Session rail、Chat、输入区和 Provider 设置；
- B3：Trace 投影与 Inspector DTO（已实现独立 `src/web/trace` 投影、稳定 seq/upsert、Inspector 与有界列表；未改 App/路由装配）；
- B4：安全、浏览器测试夹具和产物构建管线。

B2/B3 使用阶段 A 的 DTO 与 Fake transport，不直接修改 Agent Loop。共享路由装配和主壳由集成任务
统一合并。

### 阶段 C：集成验收

1. 连接真实 Web adapter 与前端；
2. 完成断线、刷新、审批、取消和跨 Session 浏览；
3. 完成大型 Session、无障碍和隐私验收；
4. 完成 Windows 产物 smoke 和 P0/P1 回归；
5. 使用受控真实 Provider 完成一次 Web Chat 与恢复；
6. 同步所有文档、演示说明和验收矩阵；
7. 删除 [p2-webui-demo.md](./p2-webui-demo.md) 与 [p2-webui-demo/](./p2-webui-demo/) 全部 PNG，
   并清除文档引用。不得把 demo 图留作产品截图。

## 10. 文档同步规则

每个 P2 实现任务必须同时更新：

- 行为所属的 ADR、API 或 UI 规格；
- 对应 DTO/Schema 和测试；
- [architecture.md](../architecture.md)、[security.md](../security.md) 或
  [testing.md](../testing.md) 中受影响的跨阶段事实；
- 本计划的完成状态和验收证据。

API、事件、工作区、认证、单活动 Turn、配置落点或技术基线变化属于架构决策，必须先修订 ADR。
纯视觉调整不能改变领域语义。实现提交不得把 `Accepted design contract（尚未实现）` 静默改成已交付；
只有完整验收通过后才更新实现状态。

## 11. 最终验收标准

P2 完成必须同时满足：

- WebUI 与 CLI 共享应用服务、配置服务、Agent Loop、Policy 与 Session repository；
- 固定工作区不可由页面更改，进程任意时刻只有一个活动 Turn；
- 回环服务通过一次性 bootstrap、Cookie、Host、Origin 和 Schema 校验阻止跨站本地调用；
- API Key、认证材料、reasoning 和绝对个人路径不进入前端或 Session；
- Session 新建、列表、恢复、Chat、Trace、取消和审批在刷新/断线后保持一致；
- Provider 设置与 CLI 配置使用同一 Schema 和原子写入；
- Trace 以业务事件解释 Turn/Step、Context、工具、策略、审批、验证和停止原因；
- 测试证据来自实际工具结果，不从模型声明推断；
- 完整质量门、Playwright、Windows 产物 smoke、秘密扫描和身份扫描通过；
- P0/P1/P1.5 的 `run`、`chat`、`config`、Session 与非交互行为不退化；
- 临时 demo 示意图及说明已删除，文档不再引用它们。

## 12. 主要风险

- 本地 Web 服务可以触发代码执行，回环监听仍需防范 DNS rebinding、CSRF 和恶意网页访问；
- 页面刷新、SSE 重连和重复 POST 可能产生副作用，必须依赖 seq、requestId 和领域幂等；
- Provider 配置页面若复制 CLI 写入逻辑会产生双契约，必须先抽共享服务；
- 多 Session 导航容易被误实现为多 Turn 并发，必须保持进程级仲裁；
- 大型 Session、输出和 diff 可能导致浏览器卡顿，需要 bounded DTO、分页与虚拟化；
- 可解释性不等于思维链公开，P2 只展示输入、动作、策略、结果和验证证据；
- 浏览器端测试与 Windows CI 会增加耗时，必须分层保留快速单测与有限 E2E；
- 第三方项目只作为交互参考，ECHO 保持独立实现与原创结构。
