# ADR-0001：ECHO Harness 项目基础

> 状态：Accepted
>
> 日期：2026-08-27
>
> 接受日期：2026-08-28
>
> 决策者：项目维护者

## 1. 背景

ECHO Harness 需要在较短周期内交付一个高质量、可演示、可解释的本地 coding agent。核心能力必须由项目独立实现，包括模型交互、Agent Loop、上下文管理、工具调度、本地文件与命令执行、安全策略、错误处理和终止判断。

项目以 Windows 开发与演示为第一环境，可使用 OpenAI-compatible 模型服务。交付质量优先于功能数量，CLI 主体完成后才评估前端或域名展示页。

本 ADR 固化首个版本的基础决策，防止实现过程中重复讨论或无意扩大范围。

## 2. 决策

### 2.1 产品与仓库

- 产品名：**ECHO Harness**；
- ECHO：**Execution · Context · Harness · Orchestration**；
- 仓库名：`ECHOCodingHarness`；
- CLI 可执行名：`echo-harness`，避免与系统 `echo` 命令冲突；
- 定位：**A lightweight, local-first autonomous coding agent built from scratch.**

### 2.2 技术栈

- TypeScript；
- Node.js 22；
- pnpm；
- TypeScript strict mode；
- tsup 构建；
- Vitest 测试与 V8 覆盖率门禁；
- ESLint 静态检查与 Prettier 格式化；
- GitHub Actions Windows 质量流水线；
- 首版采用单包结构，只有实际复杂度证明必要时才拆为 monorepo。

### 2.3 模型接入

- 定义项目自有 `ModelProvider` 抽象；
- 首个实现面向 OpenAI-compatible API；
- 使用官方 `openai` npm 包承担 HTTP/SSE 与协议解析；
- Provider 不执行工具、不控制 Agent Loop、不管理会话；
- 只对至少一个真实服务做端到端验证；其他服务描述为配置兼容候选，不做未经验证的承诺。

### 2.4 交付界面

- P0：`echo-harness run <goal>`；
- P1：`chat` 和 `config`；
- P2：React/Vite 页面、本地服务和域名展示；
- P2 在核心、测试、演示和文档完成前不启动。

### 2.5 Agent 核心

- 自行实现显式 Turn/Step Agent Loop；
- 模型工具调用由 Orchestrator 顺序调度；
- 采用追加式 Session Event Log 与 Context Projection；
- 设置最大 Step、重复工具调用保护、超时与取消；
- 工具调用使用明确的 requested/authorized/started/terminal 状态；
- Context 首版采用确定性裁剪和近似 token 预算，不使用向量数据库。

### 2.6 工具范围

首版只实现：

- `list_files`
- `search_text`
- `read_file`
- `write_file`
- `apply_patch`
- `run_command`

不提供通用删除、浏览器、网络、MCP、专用 Git 写操作或子智能体工具。

### 2.7 安全默认值

- 工作区路径隔离是硬边界；
- 采用 `safe`、`balanced`、`auto` 三种模式；
- `balanced` 为默认模式；
- 明确、局部的文件编辑与常见测试命令可自动执行；
- 依赖安装、Git 写入、外部网络、删除和宽泛副作用需要审批；
- 工作区逃逸、凭据读取/泄露、提权和宽泛破坏为硬拒绝；
- 硬拒绝不得被任何模式或用户批准覆盖；
- API Key 不进入会话事件、模型上下文或工具子进程环境。

### 2.8 会话与可观测性

- 会话以脱敏 JSONL 事件保存到 `.echo/sessions/`；
- `.echo/` 默认被 Git 忽略；
- CLI 由领域事件渲染进度；
- 未来 UI 如存在，也消费同一事件契约；
- 所有工具调用必须有且只有一个终态。

### 2.9 质量策略

- Fake Provider 测试 Agent Loop，不在 CI 调用真实付费 API；
- 单元测试覆盖 Provider 映射、工具、策略、上下文和事件；
- 集成测试在临时工作区执行；
- Windows CI 至少运行 lint、typecheck、test、build 和 demo smoke；
- 演示使用可重置的 TypeScript 失败测试 fixture，展示“定位—修改—复测—完成”；
- 提交前执行秘密与双盲身份扫描，并保留人工复核。

### 2.10 原创性边界

- 不使用 Agent 框架、Agent SDK 或托管代码/文件工具；
- 不包装现有 coding agent 产品或界面；
- 不复制 DeepSeek Harness、OpenCode 或其他项目的代码与私有结构；
- 可以学习公开的通用工程思想，但核心控制流、工具、安全与事件模型独立设计、实现和测试。

## 3. 选择理由

### 3.1 TypeScript 而非 Python

TypeScript 与 Node.js 适合同时承载 CLI、流式协议、结构化工具 Schema 和未来 React 页面。共享类型可以降低 Agent 事件、Provider 与 UI 之间的契约漂移。Node 在跨平台子进程和 CLI 生态上足以满足首版需求。

Python 在快速脚本和 AI 生态方面有优势，但本项目不依赖训练、数据科学或 Python Agent 框架；若后期增加前端，Python 还会引入第二套语言和类型边界。短周期内，单一 TypeScript 栈的整体一致性更重要。

### 3.2 OpenAI-compatible 而非单厂商协议

目标服务普遍提供 OpenAI-compatible 接口。一个窄而清晰的 Provider 抽象可以避免业务层耦合厂商，同时保持真实接入成本可控。选择官方客户端仅用于传输，不让 SDK 获得 Agent 控制权，既减少协议细节风险，也保留核心实现的独立性。

### 3.3 CLI-first 而非 Web-first

任务核心是 coding agent 的自主闭环，不是 UI。CLI 最容易验证文件修改、命令执行、退出码、非交互运行和 Windows CI，也最适合在短演示中直接展示决策过程。事件模型保留了未来 UI 的扩展点，而不提前支付前后端复杂度。

### 3.4 事件日志与投影

追加式事件可以统一调试、CLI 展示、测试断言和演示复盘。Context Projection 让模型上下文成为可测试的派生结果，而不是散落在循环中的可变消息数组。首版使用 JSONL，无需引入数据库迁移、ORM 和并发状态管理。

### 3.5 顺序工具执行

并行工具调用可提升吞吐，但会引入写冲突、审批竞态、输出排序和取消复杂度。首版的主要瓶颈是正确性与可解释性，因此选择顺序执行。未来只有在工具声明只读性且有冲突测试后，才考虑安全并行。

### 3.6 Balanced 默认模式

`safe` 会让基础演示频繁中断，`auto` 又可能让副作用范围难以解释。`balanced` 允许工作区内局部编辑与验证命令自动完成，同时保留依赖、网络、Git 写操作和删除审批，符合 coding agent 的基本自主性与安全性平衡。

## 4. 被考虑但未采用的方案

### 4.1 Python 核心 + TypeScript 前端

未采用，因为首版并不需要 Python 特有能力，双语言会增加协议、构建、测试与分发成本。

### 4.2 直接使用 Agent 框架或 Vercel AI SDK 的工具执行

未采用，因为这会把循环、工具调度或状态管理交给第三方，并弱化项目对核心能力的独立实现和解释。

### 4.3 Bun monorepo、Effect、SQLite/ORM

未采用，因为它们适合更大产品，但对三至四天的单机 CLI 闭环属于过度设计。Node.js 22 单包和 JSONL 更容易验证与交付。

### 4.4 首版同时构建 Web UI

未采用，因为 UI 会分散对核心正确性、安全性和测试证据的投入。只有 P0/P1 冻结且剩余时间充足时才重新评估。

### 4.5 完整快照、回滚与操作系统沙箱

未采用，因为实现和验证成本较高。首版通过 Git diff、局部工具、审批、路径边界与受控 fixture 管理风险，并明确不宣称强沙箱能力。

## 5. 后果

### 5.1 正面后果

- 核心能力边界清晰，便于面试解释和测试；
- 单一 TypeScript 栈降低短周期整合风险；
- 事件契约兼顾 CLI、测试和未来展示；
- OpenAI-compatible 接入允许在不改核心的情况下替换服务；
- 明确的安全策略与终态不变量提升可靠性；
- P0/P1/P2 范围冻结减少临近交付时的功能蔓延。

### 5.2 负面后果

- 首版没有图形界面，视觉展示能力有限；
- 顺序工具执行速度低于安全并行；
- JSONL 不适合复杂查询和多进程并发；
- PowerShell 命令策略无法替代真正的沙箱；
- 近似上下文预算不如精确 tokenizer；
- 不同 OpenAI-compatible 服务仍可能存在协议差异。

### 5.3 风险缓解

- 用结构清晰的 CLI 事件输出和短演示 fixture 提升展示效果；
- 使用 Fake Provider 建立确定性测试，真实服务只做受控验收；
- 在 README 明示命令执行和模型数据边界；
- 所有扩展先通过 ADR 判断是否影响交付主线。

## 6. 重新评估触发条件

出现以下任一情况时，应新增 ADR，而不是静默改变本决策：

- 需要第二种非 OpenAI-compatible Provider；
- 需要并行工具执行；
- 需要本地 HTTP 服务、React UI 或域名展示；
- 需要多进程会话、SQLite 或远程存储；
- 需要容器/操作系统级沙箱；
- 需要专用 Git 写工具、MCP、LSP 或子智能体；
- Node.js 22 在目标 Windows 环境中无法满足关键执行需求。

## 7. 接受证据

本 ADR 已基于以下证据从 `Proposed` 改为 `Accepted`：

- 项目骨架与 CI 验证所选工具链；
- OpenAI-compatible Provider 完成一次真实端到端验证；
- Agent Loop 和六个工具通过自动化测试；
- 安全策略验证与 [security.md](../security.md) 一致；
- 实现接口与 [contracts.md](../contracts.md) 对齐；
- 架构描述与 [architecture.md](../architecture.md) 对齐。

P1 配置来源、应用服务与可恢复 Session 由 [ADR-0002](./0002-p1-config-artifact-root.md) 和 [ADR-0003](./0003-p1-application-service-session.md) 补充，不静默修改本节已接受的 P0 边界。
