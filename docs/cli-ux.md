# ECHO Harness CLI 展示与交互规范

> 状态：Accepted
>
> 版本：1.1
>
> 最后更新：2026-08-29

## 1. 文档目的

本文定义 `echo-harness` 首个版本的终端展示和交互规范，使 CLI 在真实使用、自动化测试、Windows CI 和演示视频中保持一致、清晰且可审查。

本文只约束表现层。Agent Loop、Provider、工具、安全策略和事件状态以 [architecture.md](./architecture.md)、[contracts.md](./contracts.md) 和 [security.md](./security.md) 为准。

## 2. 范围与非目标

### 2.1 当前范围

- `echo-harness run <goal>` 的帮助、运行进度、审批、错误和最终摘要；
- P1-3 分组式时间线：独立 Step 标题、工具/审批/结果分组、宽度感知换行与 ASCII 降级；
- Chat 表现层：启动摘要、状态条、`YOU` 提示符、`ECHO` 回复节奏与 `/status`（由 P1-1B 接入命令）；
- 显式 `--verbose` 诊断模式；
- `EchoEvent` 到终端文本的确定性映射；
- TTY、非 TTY、CI 和 `NO_COLOR` 环境的兼容行为；
- 相对路径、diff、退出码、耗时和截断状态的展示；
- 可进行 snapshot/行为测试的渲染边界。

### 2.2 非目标

- 不设计 React/Web 页面；
- 不承诺 `chat` 或机器可读输出模式进入 P0；
- 不实现 Spinner、原地刷新、折叠式 TUI 或底部状态栏；
- 不展示模型内部推理或隐藏思维过程；
- 不用动画、图标数量或主题复杂度衡量产品质量；
- 不让 CLI 文案参与 Agent 状态判断。

P1 分组式时间线、Chat 启动摘要与粘贴边界以 [p1-cli.md](./plans/p1-cli.md) 第 5 节和 [ADR-0003](./decisions/0003-p1-application-service-session.md) 为准。本文描述 P1-3 落地后的当前 `run`/`chat` 渲染器；stdout/stderr、退出码与追加式输出仍保持 P0 契约。P1-2A 增加 `echo-harness config`，其交互属于配置向导，不改变 `run` 的渲染契约。

## 3. 设计原则

1. **信息先于装饰**：用户首先看到执行了什么、结果如何以及为何停止。
2. **事件驱动**：CLI 只渲染 `EchoEvent` 和最终 `AgentResult`，不读取核心模块内部状态。
3. **语义不依赖颜色**：标签和文本必须在无颜色环境中保持完整含义。
4. **默认克制**：P0 不使用持续动画；一个操作最多产生开始与终态等必要行。
5. **适合复盘**：非交互输出稳定，便于测试、日志检查和视频剪辑。
6. **隐私优先**：默认使用相对路径，不显示密钥、用户目录、账号或未经脱敏的原始参数。
7. **不伪造成功**：工具成功、测试通过和任务完成是不同结论，必须分别表达。

## 4. 渲染架构

```text
Agent Orchestrator
       |
       v
   EchoEvent / AgentResult
       |
       v
   EventRenderer
       |
       v
   stdout / stderr
```

`EventRenderer` 是无副作用的表现适配器：

- 不执行工具；
- 不请求模型；
- 不改变事件或 Session 状态；
- 不决定审批、重试或终止；
- 不从人类可读文本反向推断状态。

同一组事件和相同渲染能力应得到稳定输出。未来界面消费领域事件，不复用终端字符串作为数据协议。

## 5. 输出通道

### 5.1 stdout

Turn 执行期间，stdout 默认只承载最终面向用户的结果文本，便于管道、重定向和脚本消费。

以下命令级内容也可以写入 stdout：

- `--help`；
- `--version`；
- 未来明确选择的机器可读输出。

### 5.2 stderr

stderr 承载执行过程和诊断：

- Step 与工具进度；
- 审批提示；
- 警告、拒绝和失败；
- 最终执行摘要；
- Turn 创建前发生的配置或参数错误。

进度写入 stderr 不表示失败。进程是否成功由 `AgentResult` 和 CLI 退出码决定。

### 5.3 `run` 参数

`echo-harness run <goal>` 支持以下 P0 参数：

- `--workspace <path>`：固定工作区，默认当前目录；
- `--model <name>`、`--base-url <url>`：覆盖 Provider 配置；
- `--safety-mode <safe|balanced|auto>`：覆盖安全模式；
- `--max-steps <count>`：覆盖 Step 上限；
- `--verbose`：增加脱敏且有界的诊断；
- `--non-interactive`：禁止审批提示，遇到 `ask` 立即拒绝；
- `--no-color`：禁用 ANSI 颜色。

非 TTY、CI、`NO_COLOR` 或 `--no-color` 会关闭颜色；只有 stdin 与 stderr 均为 TTY 且未
指定 `--non-interactive` 时才启用审批交互。Ctrl+C 通过同一个 `AbortSignal` 传播到
Provider 与在途工具，并映射为退出码 130。

## 6. 终端能力检测

Renderer 在启动时确定能力，不在每个事件中重复探测：

| 条件 | 颜色 | 动态覆盖 | Unicode 装饰 |
| --- | --- | --- | --- |
| 交互式 TTY | 可用 | P0 关闭 | 可选但非必要 |
| 非 TTY/重定向 | 关闭 | 关闭 | 使用 ASCII 优先文本 |
| CI | 关闭 | 关闭 | 使用 ASCII 优先文本 |
| 设置 `NO_COLOR` | 强制关闭 | 不受影响 | 不受影响 |

Windows Terminal 和传统控制台都必须能读懂输出。稳定标签使用英文；Unicode 分隔符只在 TTY 且能力允许时启用，非 TTY 使用结构相同的 ASCII 版本。不依赖 emoji 或特殊字体。

`RenderCapabilities.verbose` 只由用户显式传入 `--verbose` 时启用，默认值为 `false`；TTY、CI 或环境探测不得自动打开它。详细模式可以增加 Session 短 ID、模型请求完成、用量、上下文预算、裁剪和错误 code 等脱敏诊断，但不得输出推理字段、原始请求、密钥、完整异常对象，也不得覆盖 `NO_COLOR`、输出上限或其他安全规则。可选的 `columns` 只影响换行与窄终端堆叠，不改变事件顺序或 stdout/stderr 通道。

## 7. 视觉语言

### 7.1 稳定标签

普通事件使用 10 字符标签列，标签后始终输出一个空格和显式分隔符（Unicode `│` / ASCII `|`）。不得只靠 `padEnd()` 制造间隔。

| 标签 | 含义 | 建议颜色（TTY） |
| --- | --- | --- |
| `ECHO` | 目标摘要或面向用户的模型内容 | 青色 |
| Step 标题 | 独立 Step 边界，不再使用并列的 `STEP` 标签行 | 蓝色加粗 |
| `TOOL` | 工具名 | 青色 |
| `COMMAND` / `PATH` / `QUERY` / `TARGET` | 工具摘要字段 | 默认前景色 |
| `APPROVAL` | 等待用户决策 | 黄色 |
| `APPROVED` | 用户或会话已授权 | 绿色 |
| `RESULT` | 工具终态；成功词为 `OK`，失败词为 `FAIL` | 绿 / 红 |
| `WARN` | 可继续的异常或截断 | 黄色 |
| `DENIED` | 策略或用户拒绝 | 红色 |
| `FAIL` | 不可恢复的模型或配置失败 | 红色 |
| `LIMIT` | 达到步数、重复或预算限制 | 黄色 |
| `CANCELLED` | 用户或上层取消 | 黄色 |
| `VERIFIED` / `LAST CHECK` / `NOT VERIFIED` | 验证证据；失败 Turn 不得使用 `VERIFIED` | 绿 / 默认 / 黄 |

颜色只作用于标签、标题或状态词，不染整行正文。颜色只能增强辨识度，标签本身必须完整表达语义。不得把 `tool.completed` 渲染成 Turn 完成，也不得仅凭命令输出中的文字推断测试通过。

### 7.2 默认布局

- 每个 Step 使用独立标题；标题前恰好一个空行，标题与第一条事件之间不再空行；
- 同一工具的请求、审批和结果连续显示；
- 长内容在正文列换行并对齐；CJK 按终端显示宽度计列，ANSI 不计入宽度；
- 终端过窄时改为堆叠布局，不丢弃截断标记、相对路径或脱敏结果；
- 默认不显示墙钟时间；完成事件可以显示耗时、退出码和截断状态；
- 路径相对工作区显示；`--no-color` 只移除 ANSI，不删除状态词、缩进或分隔符。

## 8. 事件映射

| 领域事件 | 默认渲染 |
| --- | --- |
| `session.started` | 默认隐藏；`--verbose` 可显示 Session 短 ID |
| `session.resumed` / `model.changed` / `safety.changed` | `run` 默认无输出；Chat 启动摘要与 Slash 反馈由 Chat 表现层渲染 |
| `turn.started` | `ECHO` 目标摘要 |
| `step.started` | `── Step <n> ──` 或 ASCII `-- Step <n> --` |
| `context.projected` | 默认隐藏；详细模式可显示预算与裁剪摘要 |
| `model.started` | 默认不单独输出 |
| `model.text_delta` | 按 Step 缓冲普通 assistant 内容；不得接收或渲染推理字段 |
| `model.tool_call` | 默认隐藏；`--verbose` 可显示模型提出了哪个工具，但不回显未校验的完整参数 |
| `model.completed` | 默认隐藏；`--verbose` 可显示 finishReason 与已提供的 usage |
| `model.failed` | 可重试时显示 `WARN`；不可恢复时显示 `FAIL`，最终退出仍由 Turn 终态决定 |
| `tool.requested` | `TOOL` 与 `COMMAND` / `PATH` / `QUERY` / `TARGET` |
| `approval.requested` | 挂在当前工具下的 `APPROVAL` 块 |
| `approval.granted` | `APPROVED` 与授权范围 |
| `approval.denied` | `DENIED` |
| `tool.authorized` | 默认隐藏；`--verbose` 可显示策略允许及授权来源 |
| `tool.started` | 默认隐藏 |
| `tool.completed` | 同一分组中的 `RESULT` |
| `tool.failed` | `RESULT` 中的 `FAIL` |
| `tool.denied` | `DENIED` 与策略原因 |
| `tool.cancelled` | `CANCELLED` 与取消阶段 |
| `limit.reached` | `LIMIT` 与具体限制 |
| `turn.completed` | `run`：stdout 最终文本，stderr `Run completed` 摘要；Chat：stderr `ECHO` 回复与 `Turn completed` |
| `turn.failed` | stderr `Run failed` / `Turn failed`，含 `REASON`；不得使用 `VERIFIED` |
| `turn.cancelled` | stderr 取消摘要 |

高频增量事件应在内存中聚合，不逐 token 产生日志行。JSONL Session Event Store 仍保存契约要求的脱敏事件。

Provider 只能把普通 assistant content 转换为 `model.text_delta`；provider-specific reasoning、analysis 或思维字段不得进入该事件。一个 Step 聚合结束后：

- 若包含工具调用，合格的中间 assistant 文本可以作为 `ECHO` 进度说明写入 stderr，不得进入 stdout；
- 若不包含工具调用并形成最终答复，`run` 的聚合文本由 `turn.completed` 路径写入 stdout；
- 空白、重复或只描述内部推理的中间文本不显示；
- Renderer 不自行判断文本是不是最终答复，以 Orchestrator 产生的 Step/Turn 事件为准。

## 9. 工具展示

### 9.1 文件工具

```text
TOOL       | read_file
PATH       | src/parser.ts
RESULT     | OK | 84 lines read

TOOL       | apply_patch
TARGET     | src/parser.ts
RESULT     | OK | 1 file changed | +4 -2
```

- 只显示相对路径；
- 列表和搜索默认显示命中数量及有限结果；
- 读取结果不默认回显完整文件；
- 写入与补丁必须显示受影响文件和变更摘要。

### 9.2 命令工具

```text
TOOL       | run_command
COMMAND    | pnpm test
RESULT     | FAIL | exit 1 | 2.4 s
           | 1 test failed
```

- 显示经过脱敏的命令摘要，不展示隐式 Shell 包装细节；
- stdout 与 stderr 必须能够区分；
- 显示退出码、耗时、超时/取消和截断状态；
- `exit 0` 只表示命令成功，不自动表示用户任务完成。

## 10. diff 与长输出

- 默认使用统一 diff 或紧凑变更统计；
- diff 文件头只使用相对路径；
- 大 diff 默认显示统计和有限片段，完整内容由会话记录或后续命令定位；
- 截断必须显示 `truncated`、原始大小和保留范围；
- 保留头尾时必须插入清晰的省略标记；
- 不得把截断结果渲染成完整结果。

## 11. 审批交互

审批提示必须包含：

- 工具名；
- 规范化后的目标或命令摘要；
- 风险原因；
- 影响范围；
- 可选决策：拒绝、仅本次允许、当前 Session 对等价操作允许。

示例：

```text
APPROVAL   | Required
           | Risk   dependency and lockfile changes
           | Scope  once or equivalent operations in this session
           | Approve [y] once / [s] session / [n] deny
```

非交互模式不得等待不可见输入；遇到 `ask` 默认拒绝并返回稳定退出码。hard deny 只显示原因，不提供允许选项。交互模式把选择提示留在同一行，用户输入后追加 `APPROVED` 或 `DENIED`，不原地擦除。

## 12. 错误与恢复提示

错误展示回答两个问题：发生了什么、下一步可以做什么。

```text
FAIL       | provider_auth | authentication failed
           | Check whether ECHO_API_KEY is configured for the selected endpoint.
```

- 不显示原始异常对象、授权头或完整堆栈；
- 详细模式可以显示经过脱敏的错误 code 和因果链摘要；
- 可恢复工具错误显示给 Agent 后，CLI 可以继续展示下一 Step；
- 只有 Turn 终止时才输出最终失败摘要和非零退出码。

## 13. 最终摘要

最终摘要与最后一个 Step 分离，并优先回答整体状态、原因与验证证据：

- 独立标题：`Run completed` / `Run failed` / `Run cancelled` / `Run limited`（Chat 使用 `Turn ...`）；
- `STEPS`、`TOOLS`、`CHANGES`；
- 成功且最后一次检查退出码为 0 时使用 `VERIFIED`；失败或取消时若有检查使用 `LAST CHECK`；没有检查时使用 `NOT VERIFIED`；
- 截断、拒绝或限制提示（若存在）。

示例：

```text
-- Run completed -----------------------------------------
STEPS      | 4
TOOLS      | 4
CHANGES    | 1 file
VERIFIED   | pnpm test | exit 0 | 4.8 s
```

最终摘要只能陈述事件可证明的事实。标题中的 completed 表示 Orchestrator 正常完成，不代替测试或人工验收证明任务正确。

## 14. 完整演示示例

```text
ECHO       | Fix the failing parser tests without modifying tests.

-- Step 1 ------------------------------------------------
TOOL       | search_text
QUERY      | "parseReport" in src
RESULT     | 3 matches

-- Step 2 ------------------------------------------------
TOOL       | run_command
COMMAND    | pnpm test
RESULT     | FAIL | exit 1 | 2.4 s
           | 1 test failed

-- Step 3 ------------------------------------------------
TOOL       | apply_patch
TARGET     | src/parser.ts
RESULT     | OK | 1 file changed | +4 -2

-- Step 4 ------------------------------------------------
TOOL       | run_command
COMMAND    | pnpm test
RESULT     | OK | exit 0 | 2.1 s
           | 12 tests passed

-- Run completed -----------------------------------------
STEPS      | 4
TOOLS      | 5
CHANGES    | 1 file
VERIFIED   | pnpm test | exit 0 | 2.1 s
```

真实实现不得为了匹配示例而伪造 Step 数、测试数量或结果。

## 15. 可访问性与语言

- 标签、缩进和文字同时表达状态，不只依赖红/绿色；
- `NO_COLOR` 和非 TTY 输出不得含 ANSI 转义序列；
- P0 使用英文稳定标签，模型最终答复保持用户使用的语言；
- 不依赖 emoji、图标字体或终端主题；
- 终端宽度不足时优先换行子信息，不截断状态标签和退出码；
- 错误文案避免只有内部 code，没有用户可执行建议。

## 16. 隐私与双盲

- 模型可见和终端可见路径均优先使用工作区相对路径；
- 不显示 API Key、Authorization、环境变量转储或凭据片段；
- 不显示用户主目录、Git author/email、仓库 owner 或系统用户名；
- 演示模式不得自动打开浏览器或账号页面；
- 视频录制前仍需人工检查标题栏、提示符、通知、历史命令和滚动区域。

Renderer 必须消费已脱敏事件，同时在最终输出前执行防御性脱敏。二次脱敏不能替代源头不采集。

## 17. 测试要求

### 17.1 单元与 snapshot 测试

- 每种终态事件至少一个渲染用例；
- stdout 与 stderr 路由；
- TTY、有色、无色、非 TTY 和 `NO_COLOR`；
- 窄终端堆叠布局、CJK 与 ANSI 可见宽度；
- Chat 启动摘要、状态条、`YOU` 提示符和 Slash 反馈；
- 相对路径与敏感路径脱敏；
- diff、命令输出和错误截断；
- 审批允许、拒绝与 hard deny；
- 最终摘要不混淆工具成功、验证成功与任务完成；
- 同一输入产生确定性文本。

### 17.2 CLI 集成测试

- `--help` 和 `--version`；
- `--verbose` 默认关闭且只增加脱敏诊断；
- 非交互运行不等待审批输入；
- stdout 可单独重定向为最终结果；
- stderr 包含进度但不改变退出码；
- Ctrl+C、失败、限制和成功使用对应退出码；
- 输出不含 ANSI、密钥或绝对个人路径。

### 17.3 CI 与烟测

CI 使用 Fake Provider 执行最小事件序列，并验证稳定输出。真实模型输出不做 snapshot，不作为 CI 依赖。

## 18. 与视频展示的关系

- 使用默认文本渲染，不为视频维护第二套输出；
- 只展示对理解闭环必要的事件；
- 失败测试、补丁和复测成功应在同一连续会话中出现；
- 最终画面保留 `Run completed` 摘要和测试证据；
- 如终端颜色影响压缩或可读性，使用 `NO_COLOR` 录制也必须成立。

## 19. 变更与接受证据

颜色、间距和措辞属于本文管理的可演进细节。stdout/stderr 语义、无颜色行为、隐私要求、Renderer 无副作用及任务/工具成功不得混淆属于稳定契约；改变这些内容应同步审查 [contracts.md](./contracts.md)。

本文已基于以下证据升级为 `Accepted / 1.1`：

- `EventRenderer` 已实现分组式时间线，并具有 snapshot/行为测试；
- 窄宽度、CJK、无颜色、非 TTY、审批和成功/失败摘要经过验证；
- stdout/stderr 与退出码契约保持 P0；
- Chat 启动摘要、状态条与 `YOU` 提示符由独立表现层覆盖，供 P1-1B 接入；
- 文中示例与真实输出一致，不含伪造能力。
