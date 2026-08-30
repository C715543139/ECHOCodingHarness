# ECHO Harness WebUI 产品与交互规格

> 状态：Accepted design contract（A4 主壳、B2 Session/Chat/设置组件及 B3 Trace 投影、Inspector 与有界列表已落地；真实 HTTP 与根组件装配仍待 C1）
>
> 版本：1.3
>
> 最后更新：2026-08-30

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
重连期间可以附加“正在重连”的辅助文案。该状态不代表 Provider、Agent 或工具执行成功。

工作区脱敏名称只出现在 Session rail。当前模型、安全模式和近似上下文用量的固定摘要只出现在
输入区；历史 Context 事件及其预算/裁剪详情仍可出现在 Trace 与 Inspector。

在 Trace 选中记录或 Chat 展开结构化工具详情时，右侧按需出现 Inspector：

```text
Session rail | Chat or Trace | Inspector
```

未选中记录时 Inspector 完全收起，不保留空列。设置以模态窗口覆盖主壳，不建立独立路由层级。

### 2.2 响应式

- `>= 1200px`：Session rail 固定，Inspector 按需显示；
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

公开产品只作为布局与渐进披露参考。ECHO 不复刻其品牌、颜色、图标、文案、组件代码或插件结构。

桌面信息架构的临时视觉参考是 [p2-webui-demo.md](./plans/p2-webui-demo.md) 与
[p2-webui-demo/](./plans/p2-webui-demo/) 中的三张示意图。示意图只确认两栏/三栏、侧栏、
`对话 / 轨迹` 和输入区位置；安全模式文案、上下文上限、发送按钮可用态、Session 文字状态、
Inspector 区块和审批/空态均以本文与 [web-api.md](./web-api.md) 为准，不以图为准。消息复制可作为
非阻塞增强；消息刷新不进入 P2。这些图是非最终视觉稿，P2 完成后必须删除，见
[p2-webui-demo.md](./plans/p2-webui-demo.md) 的删除条款。

## 4. Session rail

### 4.1 固定内容

顶部包含 ECHO 标识与“新会话”主操作；底部包含设置入口。工作区只显示脱敏目录名，不显示绝对
路径，也不提供工作区选择按钮。

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
状态。P2 不提供删除、批量管理、跨工作区搜索或拖拽排序。

## 5. Chat

### 5.1 阅读流

Chat 按 Turn 显示用户输入、聚合代理正文、工具摘要、审批与终态。历史只使用 Session 聚合事实；
刷新后不重放逐 token 动画。

默认隐藏：

- `model.reasoning` 与 reasoning details；
- Provider 原始分片；
- 完整工具参数和长输出；
- 内部重试和 HTTP 诊断。

工具摘要只显示名称、状态和一行结果，状态取
`running` / `awaiting_approval` / `completed` / `failed` / `denied` / `cancelled`。Chat 工具行
不得使用 `Verified`。`Verified` 只出现在验证记录或 Inspector，且只来自服务端对真实
`run_command` 终态的结构化投影；模型文字中的“测试通过”不能生成成功标记。用户主动展开工具摘要时
复用 Inspector 的结构化内容。

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

发送与停止是两个控件，不是同一按钮的切换。空闲时发送可用、停止不出现。运行时发送禁用，停止出现
在运行提示条；`Escape` 不取消 Turn。停止必须再次确认目标 Session，不依赖页面关闭。示意图里运行中
仍为蓝色发送按钮，实现不得照做。

键盘语义：

- `Enter` 发送；
- `Shift+Enter` 换行；
- 运行时发送不可用，不实现排队或 steer；
- `Escape` 只关闭当前弹层，不取消 Turn。

模型和安全模式选择复用 CLI `/model`、`/safety` 的领域语义，不引入 `Workspace Write` 等第三方权限
标签。示意图中的 `Workspace Write` 不是安全模式。活动 Turn 期间禁用切换；切换只影响当前 Session
的下一个 Turn，不写回 Provider 默认配置。

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

- 位于底部时自动跟随当前代理记录；
- 用户向上滚动后暂停跟随，并显示“有新内容”按钮；
- 流式正文更新同一消息，不插入大量 DOM 节点；
- 页面刷新从聚合 Session 事实恢复；
- 断线保留已提交内容，显示重连状态，不自动重试用户命令。

## 6. Trace 可解释性工作台

### 6.1 范围

Trace 是按时间顺序排列的业务事件记录，不提供顶部图形时间线，也不是模型思维链查看器。列表按
Turn 和 Step 使用轻量分隔线分组，默认从旧到新排列。

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

无内容的区块不显示。长文本、命令、JSON 和 diff 使用有界代码视图，可复制已经脱敏的内容；默认
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

Trace 每页最多 100 条，并虚拟化已加载行。向上查看历史时暂停自动跟随；SSE 新记录只增加“新事件”
提示。P2 首版不实现全文搜索、复杂筛选、时间缩放或记录深链接；事件类型筛选可在性能和无障碍基础
完成后作为非阻塞增强。

## 7. Provider 设置

设置采用居中模态窗口与左侧导航。P2 只注册 `Provider` 导航项；不显示空的未来项，也不实现插件、
Agent 预设或工作区设置。

Provider 页面包含：

- Base URL 输入；
- 模型目录模式：自动发现或手动维护，二选一；
- 自动发现的显式“获取模型”操作和只读结果列表，不用单选把发现结果写成当前 Session 模型；
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

- 主壳具有跳到主内容入口与清晰 landmark；
- Session、Chat/Trace 和 Inspector 的阅读顺序与视觉顺序一致；
- 所有功能可用键盘完成，焦点环始终可见；
- 模态打开后焦点进入标题或首个字段，关闭后返回设置按钮；
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

## 12. 明确不做

- 页面内选择或切换工作区；
- 多个并发 Turn、排队、steer 或子代理；
- TUI、Skill、插件、MCP 和 Provider 多配置档案；
- Session 删除、fork、分支对话或跨工作区搜索；
- 顶部图形时间线、逐 chunk 日志和思维链查看器；
- 浏览器端 API Key 管理；
- 远程访问、账号系统、域名部署或多用户权限；
- 导出会话（Markdown、JSON 或其它下载）；
- 消息刷新操作，以及把发现模型列表当作当前 Session 模型选择器；
- 用 `Workspace Write` 或其它第三方权限名替代 `safe` / `balanced` / `auto`。
