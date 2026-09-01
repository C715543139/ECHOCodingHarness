# ECHO Harness WebUI 产品与交互规格

> 状态：Accepted
>
> 版本：2.1
>
> 最后更新：2026-09-01

## 1. 产品定位

ECHO WebUI 是**启动工作区内的图形化 Coding Agent 控制台**。它覆盖新建与恢复 Session、Web Chat、
审批、模型和安全模式切换、执行记录检查与 Provider 配置；它不是跨项目 IDE、远程服务、原始日志
浏览器或 Session 导出工具。

浏览器只投影 [web-api.md](./web-api.md) 定义的 DTO。任何页面不得解析 CLI 输出、直接读取
`.echo/sessions/*.jsonl`、复算 Policy、推断验证结论或展示 API Key。

## 2. 信息架构

### 2.1 主壳

桌面默认两栏：

```text
Session rail | Session workspace
```

Session workspace 顶部只显示当前 Session 名称、双视图切换与常驻连接状态，不显示工作区名、模型
或安全模式：

```text
当前 Session 名称
Chat | Trace | ● 已连接 / ● 未连接
```

连接状态必须同时使用文字和状态点：已连接使用绿点与“已连接”，未连接使用红点与“未连接”，颜色
不得成为唯一线索。bootstrap 已认证且本地 API 可达时显示“已连接”；选中 Session 后还要求认证 SSE
处于打开状态。无 Session 时不因尚无 SSE 而显示未连接。SSE 中断或 API 不可达时显示“未连接”，
重连期间可以附加“正在重连”的辅助文案。同一 Session 提交新 Turn 时复用已打开的 SSE，不得仅因
提交成功而切换为重连状态。服务端已经返回的结构化业务错误也不得被误判为 API 断线。该状态不代表
Provider、Agent 或工具执行成功。

工作区脱敏名称只出现在 Session rail。当前模型、安全模式和近似上下文用量的固定摘要只出现在
输入区；历史 Context 事件及其预算/裁剪详情仍可出现在 Trace 与 Inspector。

在 Trace 选中记录或 Chat 展开结构化工具详情时，右侧按需出现 Inspector：

```text
Session rail | Chat or Trace | Inspector
```

未选中记录时 Inspector 完全收起，不保留空列。设置以模态窗口覆盖主壳，不建立独立路由层级。

### 2.2 响应式

- `>= 1200px`：Session rail 默认 17.5rem，可在 208–420 px 内调宽；Inspector 按需显示，默认
  19rem，可在 256–480 px 内调宽；
- `768–1199px`：Session rail 可折叠，Inspector 作为右侧抽屉；
- `< 768px`：Session、主视图和 Inspector 使用单列分层导航；
- 首版以桌面开发工作流为主要验收目标，但 200% 缩放时不得丢失核心操作；
- 不能通过另建移动业务状态实现响应式，所有尺寸消费同一 Session 投影。

## 3. 视觉与组件原则

- 使用克制的中性背景和单一强调色，危险、警告、成功使用语义 token；
- 文本、边框和图标的对比度目标遵循 WCAG 2.2 AA；
- 状态使用文字，颜色不作为唯一线索；Session 列表只使用文字状态，不加状态图标。其它控件若使用
  图标，必须同时具有可见文字、tooltip 或可访问名称；
- 正文使用易读的 UI 字体，代码、参数、命令和 diff 使用等宽字体；
- 事件列表保持紧凑但不压缩到日志查看器密度；默认行高允许两行摘要；
- 所有可操作图标具有可见文本、tooltip 或可访问名称；
- 使用 CSS Modules 与全局语义 token，不在功能组件写入散落颜色常量；
- 动画只用于抽屉、状态过渡和流式提示，并遵循 `prefers-reduced-motion`。

### 3.1 视觉基线（P2.5）

控制台使用单一浅色主题，不提供深浅切换，也不维护第二套主题状态。权威 token 定义在
`src/web/client/styles/tokens.css`，功能组件只能引用这些语义名：

| 用途 | Token | 值 |
| --- | --- | --- |
| 画布底色 | `--echo-color-bg` | `#f7f8fa` |
| Session rail 底色 | `--echo-color-rail` | `#f4f6f8` |
| 卡面 | `--echo-color-surface` | `#ffffff` |
| 次级填充（用户气泡、代码块） | `--echo-color-surface-subtle` | `#f1f3f7` |
| 分隔线 | `--echo-color-border` | `#e3e6eb` |
| 正文 | `--echo-color-text` | `#1f2430` |
| 次要文本 | `--echo-color-muted` | `#5a6472` |
| 主色 | `--echo-color-accent` | `#2563eb` |
| 选中态填充 | `--echo-color-accent-soft` | `#e8eefb` |
| 成功 / 警告 / 危险 | `--echo-color-success` / `-warning` / `-danger` | `#15803d` / `#b45309` / `#b91c1c` |
| 运行提示条 | `--echo-color-info-soft` | `#eff4fe` |

`--echo-rail-width` 的桌面默认值为 `17.5rem`，`--echo-inspector-width` 的桌面默认值为 `19rem`，
运行时均可由对应侧栏分隔条覆盖。所有语义前景色与其所在背景的对比度不低于 WCAG 2.2 AA 正文
要求；语义色只作为文字标签的补充，
不得成为状态的唯一线索。圆角使用 `--echo-radius-sm|--echo-radius|--echo-radius-lg`，阴影使用
`--echo-shadow-card|-raised|-dialog`，布局宽度使用 `--echo-rail-width`（17.5rem 默认）与
`--echo-inspector-width`（19rem）。

公开产品只作为布局与渐进披露参考。ECHO 不复刻其品牌、颜色、图标、文案、组件代码或插件结构。

最终实现见 [ECHO local Web console 截图](./assets/echo-web-console.png)。截图来自自动化浏览器中的已实现
React 主壳与审批场景，并已通过 Web 产物隐私扫描；它只用于展示，不替代本文或
[web-api.md](./web-api.md) 的行为契约。消息复制仍只是非阻塞增强；消息刷新不进入 P2。

## 4. Session rail

### 4.1 固定内容

顶部包含 ECHO 标识与“新会话”主操作；底部包含设置入口。工作区只显示脱敏目录名，不显示绝对
路径，也不提供工作区选择按钮。

桌面侧栏右缘提供可访问的调宽分隔条，范围为 208–420 px；支持拖动、左右方向键、`Home` / `End`，
双击恢复 280 px。工作区行显示“当前工作区”和脱敏名称，不显示文件夹图标；“会话”与“当前
工作区”共用字号、字重和字距。工作区名称保持 `--echo-text-lg`，具体 Session 标题使用与“新会话”
按钮相同的 `--echo-text-base`，两者均保留 600 字重；长工作区名称允许换行，悬停或聚焦时可读取完整
名称。工作区名称在侧栏可用宽度内居中显示；不得用本机绝对路径替代它。

Session 条目显示：

- 脱敏标题或短 ID；
- 更新时间；
- 文字状态：`Idle`、`Running`、`Completed`、`Failed`、`Cancelled` 或 `Limited`；
- 当前模型的短标签。

状态只用文字，不加状态图标。颜色和高亮不能作为唯一线索。活动 Turn 所属 Session 的文字状态为
`Running`。

列表按更新时间降序，首屏 30 条，滚动到底按 cursor 加载。长标题单行截断，悬停或聚焦时显示完整
脱敏标题。

### 4.2 新建与切换

“新会话”立即创建使用当前配置的空 Session 并进入 Chat 空状态。活动 Turn 存在时仍可新建和浏览
Session，但新 Session 输入框禁用，并说明“另一会话正在运行”。

用户可以在活动 Turn 期间浏览其他 Session 历史；客户端继续保持活动 Session 的 SSE，其他历史通过
普通查询读取，全局活动状态持续可见。取消按钮只出现在活动 Session，其他 Session 不伪造可取消
状态。每个 Session 条目提供具名叉号删除按钮；删除前始终显示确认对话框。空闲或终态 Session 确认
后删除；活动 Session 显示“停止并删除”，由服务端先停止并等待 Turn 结束后再删除。失败时对话框与
Session 均保留并显示错误。删除当前 Session 后选择刷新列表中的下一条，没有剩余项时进入空状态。
P2.5 不提供批量管理、回收站、跨工作区搜索或拖拽排序。

## 5. Chat

### 5.1 阅读流

Chat 按 Turn 显示用户输入、聚合代理正文、工具摘要、审批与终态。历史只使用 Session 聚合事实；
刷新后不重放逐 token 动画。Chat 阅读区使用独立响应式留白：桌面端四周至少为
`--echo-space-6`，水平留白随视口增长但不超过 `4rem`，窄屏回落到紧凑间距，且不改变滚动所有权。
阅读流、工具摘要、审批/运行提示与输入卡在最大 `56rem` 的居中内容列上对齐；用户气泡在该内容列内
右对齐，模型正文在列内左对齐，不再分别贴近主视图两侧。主视图不足 `56rem` 时内容列随可用宽度
收缩；Trace 和 Inspector 保持各自布局。

聚合代理正文使用 `react-markdown` 与 `remark-gfm` 渲染 CommonMark/GFM 的标题、列表、引用、表格、
任务列表、删除线、链接、行内代码和代码块。用户消息保持纯文本，输入中的 Markdown 标记不得改变用户
气泡结构。模型输出按不可信内容处理：原始 HTML 被丢弃，不启用 `rehype-raw` 或
`dangerouslySetInnerHTML`；链接只允许相对地址、锚点、`http`、`https` 和 `mailto`，并以
`noopener noreferrer` 在新标签页打开；图片不发起网络请求，只显示 alt 文本占位说明。具体安全选择见
[ADR-0008](./decisions/0008-safe-web-markdown.md)。

默认隐藏：

- `model.reasoning` 与 reasoning details；
- Provider 原始分片；
- 完整工具参数和长输出；
- 内部重试和 HTTP 诊断。

工具摘要只显示名称、状态和一行结果，状态取
`running` / `awaiting_approval` / `completed` / `failed` / `denied` / `cancelled`。Chat 工具行
不得使用 `Verified`。`Verified` 只出现在验证记录或 Inspector，且只来自服务端对真实
`run_command` 终态的结构化投影；模型文字中的“测试通过”不能生成成功标记。用户主动展开工具摘要时
复用 Inspector 的结构化内容。终态行同时包含 status 与 stop reason 时，若二者文本相同则只显示
一次，例如显示 `completed` 而不是 `completed · completed`；二者不同时仍完整显示。

### 5.2 输入区

输入区固定在主视图底部，包含：

- 可自动增高的多行文本输入；
- 当前模型选择；
- 当前安全模式选择，展示名与领域值相同：`safe`、`balanced`、`auto`；
- 只读的近似上下文用量，格式为 `used / limit`，只投影 `SessionRuntimeDto.context`，前端不得自行
  估算。未配置覆盖时上限为 256,000 近似 token（另预留 16,000 输出 token）；示意图中的 `128k`
  不是默认上限；
- 发送按钮；
- 活动 Turn 提示条上的停止按钮；
- Provider、断线或全局活动 Turn 导致不可提交时的明确原因。

发送与停止是两个控件，不是同一按钮的切换。空闲时发送可用、停止不出现。选中活动 Turn 所属
Session 时发送禁用，并只显示“当前 Session 正在运行”的提示条和停止按钮；浏览其他 Session 时显示
“另一会话正在运行”，不提供停止按钮。`Escape` 不取消 Turn。停止必须再次确认目标 Session，不依赖
页面关闭。示意图里运行中仍为蓝色发送按钮，实现不得照做。终态到达后两种运行提示都必须立即消失，
不要求刷新或切换视图。

键盘语义：

- `Enter` 发送；
- `Shift+Enter` 换行；
- 运行时发送不可用，不实现排队或 steer；
- `Escape` 只关闭当前弹层，不取消 Turn。

模型和安全模式选择复用 CLI `/model`、`/safety` 的领域语义，不引入 `Workspace Write` 等第三方权限
标签。示意图中的 `Workspace Write` 不是安全模式。活动 Turn 期间禁用切换；切换只影响当前 Session
的下一个 Turn，不写回 Provider 默认配置。两个选择器固定为 `2rem` 高，并以受控行高和对称内边距
保证 Windows 浏览器中文字垂直居中，不依赖原生 select 的基线位置。

### 5.3 审批

审批在对话流和输入区上方显示唯一交互卡，包含：

- 工具与规范化动作；
- 风险原因；
- 作用域；
- `拒绝`、`仅本次允许`、`本 Session 允许` 三个明确按钮。

按钮携带精确 Session、Turn、`toolCallId` 与 `approvalKey`。提交后立即禁用，等待服务端返回；重复、
过期或非 pending 状态显示稳定解释，不再次触发工具。键盘焦点在卡片出现时不被强制抢走，但应通过
ARIA live 礼貌通知。

### 5.4 滚动与直播

- 文档根节点和主壳不滚动；Chat 只拥有纵向内部滚动，长文本不得产生页面级或 Chat 横向滚动；
- 位于底部时自动跟随当前代理记录；
- 用户向上滚动后暂停跟随，并在输入区上方显示不低于 `2.25rem`、距底部 `1.5rem` 的“回到最新”
  浮层按钮；
- 流式正文更新同一消息，不插入大量 DOM 节点；
- 同一 Session 从 `running` 进入任一终态时，自动定位到最新 Turn 的用户问题与回答起点，而不是
  整个 Session 顶部或工具列表末尾；不得为实现定位重排模型正文与工具摘要；
- 页面刷新从聚合 Session 事实恢复；
- 断线保留已提交内容，显示重连状态，不自动重试用户命令。

## 6. Trace 可解释性工作台

### 6.1 范围

Trace 是按时间顺序排列的业务事件记录，不提供顶部图形时间线，也不是模型思维链查看器。列表按
Turn 和 Step 使用轻量分隔线分组，默认从旧到新排列。首次进入 Trace、切换 Session 或在尾随状态
接收新记录时自动滚动到列表底部；底部判定只保留 `8px` 的布局误差容差，用户主动上滚超出该容差
后立即暂停尾随，即使只滚动一行也不得被虚拟列表副作用拉回底部。

固定事件类型：

| 类型 | 展示事实 |
| --- | --- |
| 用户 | 用户提交的目标 |
| 上下文 | 投影完成、预算和裁剪摘要 |
| 代理 | 模型请求、聚合正文和终止原因 |
| 工具 | 工具名称、参数摘要和终态 |
| 策略 | allow / approval / deny、rule ID 和原因 |
| 审批 | 请求与用户决定 |
| 验证 | 验证命令、退出码和证据 |
| Turn | completed / failed / cancelled / limited |

每条记录头部显示时间、类型文字、名称/动作、状态和可用耗时；下一行最多显示参数摘要与结果摘要。
流式 chunk 不形成记录。进行中的同一代理或工具使用稳定 record ID 原位更新。

### 6.2 Inspector

点击或键盘选择记录后，Inspector 按纵向区块展示：

1. 元数据：Turn、Step、时间、耗时、状态；
2. 参数：结构化字段、工具参数或 Context 摘要；
3. 结果：代理正文、工具输出、Policy 结论或验证证据；
4. 限制：截断、裁剪、取消、拒绝或输出上限；
5. 关联：对应审批、工具调用、验证或 Turn 终态。

无内容的区块不显示。桌面 Inspector 默认 304 px，可在 256–480 px 内拖动或使用键盘调整，双击分隔
条恢复默认宽度；响应式单列布局不显示分隔条。Inspector 只有纵向内部滚动，字段、命令、JSON、diff
和关联 ID 自动换行，不产生横向滚动条。代码和 diff 使用有界代码视图，可复制已经脱敏的内容；默认
折叠超长结果，并明确标记截断。Inspector 不提供原始 JSONL 和隐藏 reasoning 开关。示意图可能只画出
元数据、参数与结果，实现仍必须按上述五类区块投影。

### 6.3 特殊投影

- Context：显示策略版本、已用/上限、输出预留、纳入数量和裁剪/替代原因；不默认展示完整文件；
- Policy：只显示领域 decision、rule ID、用户可理解原因和工具最终是否执行；
- 文件变化：只显示工作区相对路径与 bounded diff；
- Verification：显示实际 `run_command`、退出码、耗时和截断；成功只表示命令退出码为 0，不夸大为
  修改正确或测试充分；无证据时显示 `Not verified`；
- Turn：显示终止状态、stop reason、Step 数、工具数和最后一条真实验证证据。

### 6.4 大型 Session

Trace 每页最多 100 条，并虚拟化已加载行。向上查看历史时立即暂停自动跟随；在列表底部显示
“回到最新”浮层提示。暂停判定不得以虚拟行高度作为阈值，避免小幅滚动被错误恢复到尾部。P2 首版
不实现全文搜索、复杂筛选、时间缩放或记录深链接；事件类型筛选可在性能和无障碍基础完成后作为
非阻塞增强。

## 7. Provider 设置

设置采用居中模态窗口与左侧导航。P2 基线注册 `Provider` 导航项；P3-B3 在扩展管理端口可用时增加
`扩展`；C1 生产装配始终提供该端口，裁剪测试装配缺失时不显示空页面。仍不实现 Agent 预设或通用工作区设置。

Provider 页面包含：

- Base URL 输入；
- 模型目录模式：自动发现或手动维护，二选一；
- 自动发现的显式“获取模型”操作和最高 `11rem` 的独立滚动只读结果列表，不用单选把发现结果写成
  当前 Session 模型；
- 手动模型的添加、去重与删除；
- 唯一可写的默认模型选择；当前 Session 模型只在输入区修改；
- API Key 状态：`已通过环境变量配置` 或 `未配置`；
- 保存与取消。

自动发现不会自动保存；保存前执行与 CLI 相同的 Schema 校验。错误靠近字段显示，并在顶部提供摘要。
活动 Turn 存在时设置只读。API Key 不提供输入框、显示、复制或清除能力。

## 8. 状态、错误与空页面

必须定义：

- 首次打开且无 Session；
- 新建空 Session；
- Provider 未配置或 API Key 缺失；
- 加载历史；
- 活动 Turn；
- 等待审批；
- SSE 重连；
- 需要完整 resync；
- Session 损坏或 Provider 不匹配；
- Turn 失败、取消、受限和完成。

错误消息说明“发生了什么、哪些内容未改变、用户可以做什么”。网络错误不得被显示为 Agent 失败，
审批失败不得被显示为工具已执行。

## 9. 明确不做的导出

P2 不提供导出会话。不实现 Session 菜单、Markdown/JSON 下载、浏览器拼接导出或对应 API。需要复盘时
继续使用 CLI 与 `.echo/sessions` 的既有能力，不在 WebUI 增加第二条导出路径。

## 10. 无障碍与键盘验收

- 主壳保留清晰的 `nav`、`main` 与按需 `complementary` landmark，不提供额外的跳到主内容入口；
- Session、Chat/Trace 和 Inspector 的阅读顺序与视觉顺序一致；
- 所有功能可用键盘完成，焦点环始终可见；
- 模态打开后焦点进入标题或首个字段；设置关闭后返回设置按钮，删除取消后返回原删除按钮；
- 抽屉和 Inspector 可通过 Escape 关闭，但不取消 Turn；
- 流式正文、审批和终态使用合适的 live region，避免逐 token 播报；
- 点击目标至少 24×24 CSS px，主要操作目标更大；
- 颜色对比、200% 缩放和 `prefers-reduced-motion` 纳入浏览器测试；
- 图标按钮、状态 badge、输入和错误均具有可访问名称。

## 11. UI 测试故事

至少冻结以下用户故事：

1. 从无 Session 状态新建会话并完成一个 Fake Provider Turn；
2. 刷新后恢复聚合正文，不重放 chunk；
3. 工具请求审批，三种决定精确绑定且重复点击无副作用；
4. 活动 Turn 时浏览另一 Session，但不能并发提交或修改运行时；
5. 取消活动 Turn 后 Provider、工具和 UI 都进入同一终态；
6. Trace 按 seq 稳定排序，选中记录展示匹配的结构化详情；
7. Context、Policy、diff 与验证证据来自服务端事实；
8. SSE 断线补齐与 resync 不重复 Turn；
9. Provider 设置与 CLI 使用同一 Schema，API Key 不进入 DOM；
10. 键盘完成 Session 切换、发送、审批、Trace 检查和设置保存；
11. Windows 构建产物在非仓库工作目录启动并打开可用页面。
12. 删除空闲 Session 必须确认；删除活动 Session 先停止并等待终态；失败保留 Session；
13. 长 Turn 完成后定位到最新问题与回答起点，不改变持久事件顺序。

## 12. 明确不做

- 页面内选择或切换工作区；
- 多个并发 Turn、排队、steer 或子代理；
- TUI、Skill、插件、MCP 和 Provider 多配置档案；
- Session 批量删除、回收站、fork、分支对话或跨工作区搜索；
- 顶部图形时间线、逐 chunk 日志和思维链查看器；
- 浏览器端 API Key 管理；
- 远程访问、账号系统、域名部署或多用户权限；
- 导出会话（Markdown、JSON 或其它下载）；
- 消息刷新操作，以及把发现模型列表当作当前 Session 模型选择器；
- 用 `Workspace Write` 或其它第三方权限名替代 `safe` / `balanced` / `auto`。
## 13. P3 Full Access 与扩展页面增量

> 状态：B3 Web 增量与 C1 真实扩展生命周期生产接线均已实现。

现有 Chat/Trace/Inspector 布局保持不变。安全模式候选增加 `full-access`；用户选择后必须先看到明确
说明网络、依赖、Git、删除、工作区外访问和任意模型命令风险的确认对话框。取消不改变模式；确认成功
后顶栏或输入区常驻红色 `FULL ACCESS` 状态，不得仅用颜色表达，也不得在 Turn 完成后消失。恢复同一
Full Access Session 时直接恢复标识；离开该模式后立即移除。

设置导航在服务端管理端口可用时增加一个“扩展”页面，与 Provider 页面并列。页面只展示当前工作区
的扩展 ID、版本、完整内容哈希、`enabled|disabled|quarantined`、提供的工具、当前进程 loaded、脱敏
隔离原因和 cleanup pending。人类可在任意 Session 安全模式和活动 Turn 期间进入页面并发起启用、
禁用或卸载；生命周期端口对活动调用返回 `EXTENSION_BUSY` 时，页面明确提示先停止当前 Turn。卸载
始终二次确认，Escape 取消后焦点返回原卸载按钮。刷新页面或重新打开设置时，扩展事实从 Web API
恢复，不依赖浏览器缓存猜测状态。UI 不提供源码编辑器、远程安装、市场、版本回滚或扩展自定义页面。

Agent 调用 `extension_*` 和动态工具继续进入现有 Chat 工具摘要、Trace 时间序列与 Inspector 结构化
详情。页面不得显示扩展源码中的秘密、绝对个人路径、Worker 原始堆栈或隐藏推理。
