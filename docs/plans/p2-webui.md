# P2 本地 WebUI 与可解释性工作台计划

> 状态：Proposed
>
> 版本：0.2
>
> 最后更新：2026-08-29

## 1. 目标

P2 在 [P1 CLI](./p1-cli.md) 完成并冻结应用服务、会话查询和事件契约后，增加一个本地 WebUI。WebUI 既提供 Chat 与历史 Session 的图形化入口，也提供 Context、Policy、工具执行和验证证据的可解释性工作台。

P2 不重新实现 Agent。CLI 和 WebUI 必须共享同一个 Provider、Agent Loop、Context Projector、工具注册表、安全策略与 Session repository。

## 2. 产品边界

P2 只包含本地 WebUI：

1. P2-1：本地 Web 服务与 API；
2. P2-2：Web Chat 与 Session 历史；
3. P2-3：可解释性工作台；
4. P2-4：WebUI 质量、测试与产物集成。

TUI、远程服务、域名部署、多用户、Skill、插件、MCP、多智能体和子代理编排均不属于 P2。Skill 与插件归入未来 P3，但 P3 当前不做任务拆解或交付承诺。

## 3. 启动方式

```powershell
echo-harness web [--workspace <path>] [--no-open]
```

- 服务只监听 IPv4/IPv6 回环地址，不监听局域网或公网接口；
- 默认在启动成功后打开浏览器，`--no-open` 只打印经过验证的本地地址；
- 端口可由 CLI 显式指定或由系统选择可用端口，启动结果必须输出实际端口；
- 工作区在服务启动时固定，P2 不在页面内切换或新增任意工作区；
- 进程退出时先停止接收新 Turn，再向唯一活动 Turn 发送取消信号，并最多等待 10 秒让其写入终态、终止子进程和释放资源；超时后强制关闭剩余执行资源，并以非零退出码报告清理未完成。

## 4. 总体架构

```text
React/Vite WebUI
   |  HTTP command/query
   |  SSE events
   v
Loopback Web adapter
   |
   v
Application service
   |
   +----> Agent Loop ----> Provider / Tools / Policy
   |
   +----> Session repository
```

前端使用 TypeScript，并优先复用领域类型的只读传输表示。Web adapter 负责认证、输入校验、传输错误映射和事件序列化，不拥有 Agent 决策逻辑。前端不得解析 CLI 文本，也不得直接读取 `.echo` JSONL 文件。

## 5. P2-1：本地 Web 服务与 API

### 5.1 能力

本地服务至少支持：

- 获取当前工作区、配置摘要和运行能力；
- 列出、创建和读取 Session；
- 恢复 Session；
- 提交一个 Turn；
- 取消当前 Turn；
- 提交一次精确的审批响应；
- 订阅 Session 实时事件；
- 读取 Context、Policy、工具结果和验证证据的脱敏视图；
- 导出一个脱敏 Session。

具体 URL 与 JSON Schema 在实现前写入独立接口文档；API 以领域对象为准，不暴露内部类、异常堆栈或磁盘路径。

### 5.2 实时事件

首版使用 SSE 传输服务器到浏览器的单向事件，用户命令、取消和审批使用普通 HTTP 请求。SSE 事件保留单调序号，使短暂断线能够从最后确认位置恢复，而不是重复执行 Turn。

一个 Session 同时只允许一个活动 Turn。重复提交、重复审批和过期审批必须幂等拒绝，不能触发第二次工具副作用。

### 5.3 本地服务安全

仅监听 `127.0.0.1` 并不足以防止恶意网页访问本地端口。P2 还必须：

- 默认关闭 CORS；
- 校验 `Origin`、`Host` 与请求内容类型；
- 在启动时生成进程级随机访问令牌，并将其安全传递给本次打开的页面；
- 对改变状态的请求验证令牌；
- 不把 `ECHO_API_KEY`、授权头或可还原秘密发送到浏览器；
- 不接受浏览器提交任意工作区根路径；
- 对 Session ID、Turn ID、审批 ID 和所有正文做长度与结构校验；
- 复用 P0/P1 的工作区隔离、命令策略、审批、超时、取消和脱敏管线；
- 页面关闭或 SSE 断开不得自动批准、取消或重新执行工具。

## 6. P2-2：Web Chat 与 Session 历史

### 6.1 布局

桌面主界面采用三栏结构：

```text
Session list | Conversation / Timeline | Detail inspector
```

窄屏可按相同信息层级折叠为抽屉或分页，不另建一套业务状态。

### 6.2 Session 列表

显示：

- Session 短 ID 或脱敏标题；
- 更新时间与 Turn 数；
- 当前模型和安全模式；
- `idle`、`running`、`completed`、`failed` 或 `cancelled`；
- 新建与恢复操作。

P2 不提供跨工作区 Session 浏览，也不允许通过前端输入磁盘路径打开任意 Session。

### 6.3 Chat

支持：

- 用户输入与流式模型文本；
- 工具调用摘要与终态；
- 当前 Turn 取消；
- 精确绑定到工具请求的审批；
- 当前 Session 内模型和安全模式切换；
- `/model` 与 `/safety` 相同的领域语义，但前端可使用选择控件；
- 失败、取消、限制和完成状态；
- 刷新页面后从 Session 事实恢复，而不依赖浏览器内存。

Provider URL、默认模型目录和 API Key 仍由 P1 的 `echo-harness config` 与环境变量管理。P2 第一版只显示脱敏配置状态，不实现重复的 Provider 配置页面。

## 7. P2-3：可解释性工作台

工作台是 Session 的观察和审计层，不是模型思维链查看器。它解释 ECHO 的输入、外部动作、结构化策略判断和验证证据，不显示或推断隐藏推理。

### 7.1 执行时间线

按 Turn 和 Step 展示：

```text
User input
Context projected
Model requested / completed
Tool requested
Policy decision / approval
Tool completed / failed / denied / cancelled
Verification evidence
Turn completed / failed / cancelled / limited
```

每个节点至少包含时间、耗时、状态和可展开的脱敏详情。刷新和恢复不得改变已经记录的历史顺序。

### 7.2 Context 投影查看器

展示：

- 投影策略版本；
- 上下文总预算与输出预留；
- 近似输入 token；
- 纳入的消息/事件数量和角色摘要；
- 被替代、裁剪、截断或因预算排除的数量与原因；
- 工具输出的原始长度和截断标记。

默认不展示完整仓库内容；用户展开时仍使用 P1 的脱敏结果。工作台不得保存或展示 Provider-specific reasoning/analysis 字段。

### 7.3 Policy Explain

策略详情基于结构化事实展示：

- `allow`、`approval` 或 `deny`；
- 稳定的 rule ID；
- 规范化后的安全摘要；
- 用户可理解的原因；
- 审批请求及其最终响应；
- 工具是否真正执行以及最终状态。

前端不得重新判断权限，也不得根据命令字符串自行推断策略结论。

### 7.4 文件变化与验证证据

展示：

- 相对工作区路径；
- 写入或补丁产生的 bounded diff；
- 验证命令、退出码、耗时和截断状态；
- 最终答复可引用的实际测试证据；
- 未进行验证时明确显示 `Not verified`，不得从模型文本推断成功。

### 7.5 脱敏导出

支持导出 Markdown 和 JSON，至少包含 Session 摘要、时间线、文件变化、策略决定、验证证据和最终状态。导出继续经过统一脱敏与身份扫描规则，不包含 API Key、授权头、个人绝对路径、隐藏推理或未经校验的敏感参数。

## 8. P2-4：质量与产物集成

### 8.1 体验

- 明确的空状态、加载状态、断线状态和错误恢复；
- 长工具输出、diff 和大型 Session 使用折叠、分页或虚拟化；
- 颜色不是唯一状态信号；
- 支持键盘操作、可见焦点和基础屏幕阅读语义；
- 流式更新不抢夺焦点，不导致时间线无界跳动；
- UI 不展示姓名、学校、账号或个人目录等双盲信息。

### 8.2 测试

至少覆盖：

- 应用服务与 Web adapter 集成测试；
- API 输入校验、鉴权、Origin/CORS 和工作区隔离；
- SSE 顺序、重连、重复事件和断线；
- Session 创建、恢复、取消和审批竞态；
- React 组件与状态投影测试；
- 浏览器端 Chat、历史、审批和工作台关键流程；
- 秘密、身份和绝对路径扫描；
- Windows 构建产物从非仓库目录启动的 smoke test。

CI 继续只使用 Fake Provider，不注入真实 Key 或调用付费服务。

### 8.3 构建产物

Web 前端静态资源随 ECHO 构建产物交付，不要求单独安装开发服务器。最终产物应同时支持：

```text
echo-harness run
echo-harness chat
echo-harness config
echo-harness web
```

## 9. 实施顺序

1. 用新 ADR 冻结本地服务、访问令牌、SSE 和前端技术边界；
2. 定义并测试 Web DTO 与接口文档；
3. 实现只读 Session/配置查询和静态资源服务；
4. 实现 Turn 提交、取消、审批和 SSE；
5. 实现 Session 列表与 Web Chat；
6. 实现时间线、Context、Policy、diff 和验证证据；
7. 实现脱敏导出、无障碍、端到端测试和产物 smoke；
8. 使用受控任务完成本地真实 Provider 验收和双盲展示审查。

## 10. 验收标准

P2 完成必须同时满足：

- WebUI 与 CLI 对同一任务使用相同应用服务、Agent Loop 和安全策略；
- 服务只监听回环地址，并通过令牌与 Origin/Host 校验阻止跨站本地调用；
- API Key 从不进入浏览器、前端包、API 响应、Session 或导出；
- 工作区在启动时固定，页面无法访问或切换到工作区外路径；
- Session 历史、恢复、实时事件、取消和审批在刷新/断线后保持一致；
- 时间线能够从事件事实解释 Turn/Step、工具、策略、Context 与停止原因；
- 测试证据来源于真实工具结果，不从模型声明推断；
- 完整质量门、Web 端到端测试、Windows 产物 smoke、秘密扫描和身份扫描通过；
- P0/P1 的 `run`、`chat`、`config` 与非交互行为不退化。

## 11. 主要风险

- 本地 Web 服务具有执行代码的能力，回环监听仍需防范 DNS rebinding、CSRF 和恶意网页对 localhost 的请求；
- SSE 重连、页面刷新和重复 POST 可能造成重复副作用，必须通过 Turn/审批 ID 和单活动 Turn 约束保证幂等；
- 大型 Session、工具输出和 diff 可能使浏览器卡顿，需要 bounded DTO 和渐进加载；
- 若 UI 建立第二套状态机，CLI 与 Web 行为会漂移，因此所有状态必须来自应用服务和 EchoEvent；
- 可解释性不等于暴露思维链。工作台只能展示可验证的输入、动作、策略结果和证据；
- DSH、OpenCode 等公开产品只作为交互形态参考，ECHO 不复制其代码、私有接口或目录结构。
