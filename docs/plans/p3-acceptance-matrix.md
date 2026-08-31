# P3 需求、测试与验收证据矩阵

> 状态：In progress / P3-A1 runtime evidence recorded
>
> 最后更新：2026-08-31

## 1. 使用规则

可机读的权威行位于 `src/contracts/p3.ts` 的 `P3_TEST_MATRIX`。A0 阶段的运行时证据使用
`pending:P3-*`，只表示所有权，不表示已经实现。P3-A1 专用分支不得修改冻结的
`src/contracts/p3.ts`，因此本文件先记录 FULL-01/02/03 的真实测试路径；共享合同解除冻结后的集成任务
必须同步可机读矩阵。P3-C3 只有在不存在 pending、所有路径存在且完整门禁通过后才能把本文改为
Accepted。

## 2. 冻结矩阵

| ID | 领域 | 要求摘要 | 实现任务 | 当前状态 / 证据 |
| --- | --- | --- | --- | --- |
| FULL-01 | Full Access | 明确人类确认并绑定 Session | P3-A1 | Implemented：`tests/unit/application/full-access.test.ts`；`tests/unit/cli/full-access-confirmation.test.ts`；`tests/integration/cli-run.test.ts`；`tests/integration/cli-chat.test.ts`；`tests/integration/web/session-view.test.ts` |
| FULL-02 | Full Access | 免逐项审批但保留可靠性边界 | P3-A1 | Implemented：`tests/unit/security/command-policy.test.ts`；`tests/integration/cli-run.test.ts`；`tests/integration/tools/run-command.test.ts`；`tests/integration/execution/powershell.test.ts` |
| FULL-03 | 回归 | safe/balanced/auto 不变 | P3-A1 | Implemented：`tests/unit/security/command-policy.test.ts`；`tests/unit/application/full-access.test.ts`；`pnpm test` / `pnpm check` |
| EXT-01 | 存储 | 只在当前工作区持久化 | P3-A2 | Planned |
| EXT-02 | 存储 | Manifest、路径、冲突、哈希、Catalog fail closed | P3-A2 | Planned |
| WRK-01 | Worker | 协议、输出、超时、取消、凭据与关闭 | P3-B1 | Planned |
| WRK-02 | Registry | 下一次模型请求可见且冲突拒绝 | P3-B1 | Planned |
| LIFE-01 | 生命周期 | 七工具、状态转换和幂等 | P3-B2 | Planned |
| LIFE-02 | 生命周期 | busy 与 cleanup pending 诚实结果 | P3-B2 | Planned |
| WEB-01 | Web | 风险确认、常驻警告和人类管理 | P3-B3 | Planned |
| INT-01 | 集成 | 同工作区复用、跨工作区隔离 | P3-C1 | Planned |
| INT-02 | 集成 | 离开 Full Access 卸载但不删除 | P3-C1 | Planned |
| DEMO-01 | 演示 | 失败基线、哈希、修复、独立复验和复用 | P3-C2 | Planned |
| DONE-01 | 收尾 | 质量、隐私、产物、真实 Provider、文档与视频 | P3-C3 | Planned |

## 3. 必须保留的证据层

- 单元：Schema、状态机、原子写入、Policy、Registry 和投影；
- 集成：Worker 进程、ApplicationService、Session 恢复、工作区隔离和 Web API；
- 浏览器：确认对话框、FULL ACCESS 标识、设置管理、失败反馈和无障碍；
- 产物：从非仓库 cwd 启动构建产物，创建、加载、关闭扩展且不依赖源码；
- 离线故事：Fake Provider 完成安装后下一步调用及新 Session 复用；
- 显式本地：真实 Provider 完成合成 PDF 任务，不进入 CI；
- 隐私：Git、Web 产物、截图、Trace 和演示视频不含秘密、个人路径或真实考核内容。

`completed` 仍只代表 Orchestrator 正常收到最终答复。测试退出码 0 只代表该命令成功；P3 的“可信
验收通过”还要求受保护输入哈希未变，并由 Harness 外部独立复验。
