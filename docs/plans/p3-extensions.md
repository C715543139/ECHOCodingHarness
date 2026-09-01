# P3：Full Access 与工作区扩展系统

> 状态：Accepted / P3-A0–P3-C3 与 P3.5 已完成
>
> 版本：1.2
>
> 最后更新：2026-09-01

## 1. 目标故事

P3 只交付一条可解释、可验证的扩展闭环：

```text
人类确认 full-access
  → Agent 识别缺少 PDF 能力
  → Agent 自主选择扩展与工具名称并创建工作区模板
  → Agent 编写处理器与自测
  → extension_check 给出结构化检查事实
  → extension_install 原子安装并热加载
  → 下一次模型请求出现新 PDF 工具
  → Agent 读取合成 PDF、修改代码并运行测试
  → Harness 外独立复验
  → 同工作区新 Session 直接复用该工具
```

它展示 ECHO 的 Execution、Context、Harness 与 Orchestration，不把项目扩张成通用插件平台。

## 2. 权威契约

- Full Access：[ADR-0010](../decisions/0010-full-access-mode.md)
- 工作区扩展：[ADR-0011](../decisions/0011-workspace-extensions.md)
- 需求与证据：[p3-acceptance-matrix.md](./p3-acceptance-matrix.md)
- P0–P2 既有契约仍由 `architecture.md`、`contracts.md`、`security.md`、`web-api.md` 和
  `web-ui.md` 管理；冲突时新 ADR 只覆盖明确写出的 P3 增量。

## 3. 生命周期工具

七个工具只在已确认的 `full-access` 中对模型可见。

### 3.1 `extension_init`

输入：`{ extensionId, toolNames }`。在 `.echo/extension-staging/<id>/` 生成
`extension.json`、`index.mjs`、`extension.test.mjs` 和 `AUTHORING.md`。已有目录时返回
`already_exists`，绝不覆盖。它检查名称冲突但不安装、不加载。

### 3.2 `extension_check`

输入：`{ extensionId }`。验证 Manifest、路径、Schema、命名冲突、Worker 初始化、handlers 一致性
和自测；返回 `passed|failed`、内容哈希、工具、通过/失败数及有界 warning。它不写 Catalog，不改变
加载状态；`passed` 只表示契约和自测通过，不表示绝对安全或逻辑正确。

### 3.3 `extension_install`

输入：`{ extensionId }`。重新执行关键检查，计算 SHA-256，经临时目录和 Worker 握手后原子更新
Catalog、设置 `enabled` 并注册工具。同哈希重复安装幂等；不同哈希原子替换。工具从下一次模型请求
开始可见。

### 3.4 `extension_list`

输入：`{}`。只读取当前工作区，返回 ID、版本、哈希、`enabled|disabled|quarantined`、工具、当前
进程 loaded、隔离原因和 cleanupPending。不得枚举全局或其他工作区。

### 3.5 `extension_enable` / `extension_disable`

输入：`{ extensionId }`。enable 重检已安装哈希与 Worker 握手后注册工具；失败保持或进入
`quarantined`。disable 注销工具、关闭 Worker、持久化 `disabled`，文件保留。相同目标状态幂等；
存在活动调用时返回 `extension_busy`。

### 3.6 `extension_uninstall`

输入：`{ extensionId }`。以扩展为单位停止、注销、原子移除 Catalog，再经 `.trash` 删除全部安装
版本与 staging。扩展不存在时幂等成功；活动调用返回 `extension_busy`；删除失败返回已停用与
`cleanupPending=true`，不伪造完全成功。

## 4. CLI 与 Web

CLI 只增加 `/safety full-access` 的风险确认和非交互 `--allow-full-access`，不增加七个 Slash 命令。
Agent 使用工具管理扩展；人类主要在 Web 设置页查看、启停和卸载。

Web 创建/切换 Full Access 必须确认，之后常驻红色 `FULL ACCESS` 标识。设置导航增加一个扩展页，
只显示当前工作区的结构化 Catalog 状态。人类直接启停或卸载不要求当前 Session 为 Full Access；模型
仍只能在 Full Access 使用管理工具和动态工具。Agent 的生命周期调用沿用 Chat、Trace 与 Inspector，
不创建第二套日志。

## 5. 实施任务与依赖

| 任务 | 输出 | 前置 |
| --- | --- | --- |
| P3-A0 | ADR、计划、目标接口与验收矩阵 | 已验收 main 与远端 CI |
| P3-A1 | Full Access 授权、策略、CLI/领域运行时（已实现） | A0 |
| P3-A2 | Manifest、Catalog 与工作区存储（已实现） | A0；与 A1 合并后供 B1/B2/B3 复用 |
| P3-B1 | Worker Host 与动态 Registry（已实现） | A2 |
| P3-B2 | 创作规范与七个生命周期工具（已实现） | A1、B1 |
| P3-B3 | Full Access 与扩展 WebUI（已实现） | A0、A1、A2，可与 B1 并行 |
| P3-C1 | CLI/Web/ApplicationService 生产集成（已实现） | A1、B2、B3 |
| P3-C2 | 合成 PDF 演示与可信验收（已实现） | C1 |
| P3-C3 | 文档、全量质量、双盲与视频收尾（已完成） | C2 |
| P3.5 | 可信演示证据、旧版本清理、目标工作区 Git 隐私与文档收口（已完成） | C3 审查 |

A0 后共享类型、Schema、状态机和路由不得由并行分支私自分叉。任何必要变更先形成集成修订。

## 6. PDF 演示

`fixtures/p3-pdf-demo/` 使用公开可提交的合成文本 PDF，不使用真实考核附件。Fixture 包含 resettable
失败代码、受保护测试、`AGENTS.md` 和 golden 文件。自动验收必须：

1. 证明基线测试失败；
2. 记录 PDF、测试和配置哈希；
3. 只描述能力缺口和持久复用结果，让 Agent 自主选择扩展 ID、工具名与实现并完成检查、安装和使用；
4. 运行实际测试成功；
5. 确认受保护输入哈希未变；
6. 从 Harness 外再次执行独立验收；
7. 新 Session 复用，同路径的另一临时工作区看不到扩展。

首版只支持可提取文本的普通 PDF，不支持 OCR、扫描件、加密 PDF 或复杂版面。

已实现的可重复证据：

- `pnpm p3:demo:reset` 恢复故意错误的源码并移除该 fixture 的本地 `.echo` 运行数据；
- `pnpm p3:demo:baseline` 校验 PDF、受保护测试和 `package.json` 的 SHA-256，并要求独立测试失败；
- `tests/integration/p3-pdf-demo.test.ts` 用离线 Fake Provider 驱动完整创作、检查、安装、热加载、修复、
  复测、新 Session 复用和另一工作区不可见，并锁定首个模型请求尚无 PDF 工具；
- `pnpm p3:demo:verify` 再次检查受保护哈希，并由 Harness 外的 Node 子进程独立要求测试通过；
- `pnpm accept:p3-pdf` 使用 `.env.test` 的真实 OpenAI-compatible Provider 显式验收，临时工作区在结束后
  删除，且该命令不进入 CI。P3.5 要求提示词不得出现扩展 ID、工具名或生命周期步骤；脚本只根据首个
  Session 实际的 `extension_init → extension_check → extension_install → 动态 PDF 工具` 事件发现模型
  自主设计的能力，拒绝此前用其他工具直接读取 `requirements.pdf`，并且只在第二个 Session 自己的
  JSONL 中判定复用，避免扫描全部历史 Session 造成假阳性。首轮最多 36 步、复用轮最多 4 步，两轮
  共享 10 分钟总硬超时；失败时只报告有界工具名，不回放模型正文。

## 6.1 P3.5 审查收口

- Store 自行维护 `.echo/.gitignore`，不修改目标仓库根文件，真实 `git status --short` 必须保持干净；
- 同 ID 不同哈希替换后只保留当前版本；物理清理失败以 `cleanupPending=true` 持久化并允许幂等重试；
- 可机读矩阵每行列出全部主要运行时证据，不再只挂一个代表文件；
- ADR 状态、页眉日期和测试数字区分历史检查点与当前 P3/P3.5 基线。
- 真实 Provider 严格验收已证明自主生命周期、安装前无一次性 PDF 绕过、精确新 Session 复用、
  跨工作区隔离、独立复验和受保护哈希不变；失败输出不包含模型正文。

## 7. 两分钟镜头

- 0–15 秒：失败测试和合成 PDF 目标；
- 15–30 秒：Full Access 风险确认；
- 30–65 秒：创建、自测、安装并在 Trace 中看到扩展生命周期；
- 65–95 秒：热加载 Agent 自主创建的 PDF 工具、读取要求、修改代码、复测；
- 95–110 秒：可信验收卡与 Inspector 的真实命令证据；
- 110–120 秒：同工作区新 Session 直接复用并总结隔离/卸载。

可以加速和剪去等待，但不得把多次失败运行拼接成一次虚假的连续成功过程。

## 8. 明确不做

不实现全局扩展、市场、远程下载、签名/更新、依赖图、扩展通信、扩展 UI、MCP/Skill 协议、TUI、
多 Agent、远程 Web、OS 沙箱、OCR 和通用测试正确性证明。
