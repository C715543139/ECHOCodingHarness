# P2 需求、测试与验收证据矩阵

> 状态：Accepted plan（阶段 A 已实现；B2 组件证据已落地；B1/B3/B4 与阶段 C 尚未实现）
>
> 版本：1.6
>
> 最后更新：2026-08-30

## 1. 用法

本矩阵把 [P2 总计划](./p2-webui.md)、[Web API](../web-api.md) 和
[WebUI 规格](../web-ui.md) 转换为可交付检查项。实现任务必须在同一提交中补充对应自动化测试；集成
任务只负责共享装配和跨模块故事，不替代所有者的聚焦测试。

“计划证据”是实现后应存在的测试或脚本位置，当前不代表文件已经存在。若实现时调整路径，应同步
更新本矩阵。每项从 `Planned` 变为 `Accepted` 前，必须填入实际证据并通过完整质量门。

## 2. P2-1：服务、配置与 API

| ID | 强制行为 | 主要测试层 | 计划证据 | 状态 |
| --- | --- | --- | --- | --- |
| P2-1-01 | `web` 只监听 `127.0.0.1` 并报告实际端口；默认打开已验证 bootstrap URL，`--no-open` 只打印 | integration / artifact | `tests/integration/web/server-lifecycle.test.ts`, `tests/unit/cli/web.test.ts`, `scripts/smoke-web-artifact.mjs` | Accepted |
| P2-1-02 | 工作区启动时固定，API 不接受路径 | API security | `tests/integration/web/workspace-boundary.test.ts` | Accepted |
| P2-1-03 | 一次性 bootstrap 兑换 HttpOnly Strict Cookie | API security | `tests/integration/web/auth.test.ts` | Accepted |
| P2-1-04 | 精确 Host/Origin、无 CORS、JSON content-type 与 CSP | API security | `tests/integration/web/request-guard.test.ts` | Accepted |
| P2-1-05 | DTO 不含秘密、绝对路径、堆栈或 reasoning | unit / scan | `tests/unit/web/dto-redaction.test.ts`；真实投影器尚未实现 | Planned (contract frozen) |
| P2-1-06 | CLI/Web 共用配置 Schema、artifact-root 与原子写入 | unit / integration | `tests/unit/config/config-service.test.ts`（A2 已落地）, `tests/integration/web/provider-config.test.ts` | Planned |
| P2-1-07 | 自动发现显式执行、不自动保存、错误脱敏 | integration | `tests/integration/web/provider-discovery.test.ts` | Planned |
| P2-1-08 | 整个进程最多一个活动 Turn | application / API | `tests/unit/application/active-turn-coordinator.test.ts`, `tests/integration/web/turns.test.ts` | Planned |
| P2-1-09 | 相同 requestId 重放同一响应且不重复副作用；不同请求指纹返回幂等冲突 | contract / integration | `tests/unit/web/idempotency.test.ts`; HTTP 注入仍待 A3：`tests/integration/web/idempotency.test.ts` | Contract accepted |
| P2-1-10 | SSE 判别联合、backlog 与 live 无缝衔接并按 seq 去重 | contract / integration | `tests/unit/web/sse-contract.test.ts`; 传输衔接仍待 B1：`tests/integration/web/sse.test.ts` | Contract accepted |
| P2-1-11 | 无法连续补齐时显式 resync，不重放 POST | integration / browser | `tests/integration/web/sse-resync.test.ts`, `tests/e2e/web/reconnect.spec.ts` | Planned |
| P2-1-12 | 关闭时取消活动 Turn，10 秒内清理或非零退出 | integration / artifact | `tests/integration/web/shutdown.test.ts`（监听关闭已落地）；活动 Turn 取消仍待 B1：`scripts/smoke-web-artifact.mjs` | Partial (lifecycle accepted) |
| P2-1-13 | 每种 Policy 结论持久化稳定 rule ID 与原因，旧 Session 可读 | contract / session | `tests/unit/security/policy-explain.test.ts` | Accepted |
| P2-1-14 | 进程级 Cookie 只允许一条 SSE，heartbeat 不推进 seq | integration | `tests/integration/web/sse-ownership.test.ts`（所有权与无 id heartbeat 已落地）；seq 补齐仍待 B1 | Partial (ownership accepted) |
| P2-1-15 | 能力状态表与写操作响应 DTO 在空闲、活动 Session、其它 Session 和关闭状态一致 | contract / API | `tests/unit/web/runtime-capabilities.test.ts`, `tests/unit/web/dto-redaction.test.ts`; HTTP 投影仍待 A3：`tests/integration/web/runtime-capabilities.test.ts` | Contract accepted |

## 3. P2-2：Session、Chat 与设置

| ID | 强制行为 | 主要测试层 | 计划证据 | 状态 |
| --- | --- | --- | --- | --- |
| P2-2-01 | Session 分页、新建、恢复和状态显示 | component / browser | `tests/unit/web/session-rail.test.tsx`（B2 分页/恢复已落地）；浏览器流程仍待 B4：`tests/e2e/web/session-flow.spec.ts` | Partial (component accepted) |
| P2-2-02 | 活动 Turn 时可浏览其他 Session，但不可并发提交 | component / browser | `tests/unit/web/composer.test.tsx`, `tests/unit/web/session-rail.test.tsx`（浏览/禁用已落地）；浏览器流程仍待 B4：`tests/e2e/web/global-active-turn.spec.ts` | Partial (component accepted) |
| P2-2-03 | Chat 历史只从聚合 `model.text` 恢复 | projection / browser | `tests/unit/web/chat-projection.test.ts`（B2 已落地）；刷新浏览器流程仍待 B4：`tests/e2e/web/refresh.spec.ts` | Partial (projection accepted) |
| P2-2-04 | 流式正文更新稳定记录，不创建 chunk DOM 行 | component / stress | `tests/unit/web/chat-stream.test.tsx`（B2 已落地）；长流浏览器压力仍待 B4：`tests/e2e/web/long-stream.spec.ts` | Partial (component accepted) |
| P2-2-05 | 上滚暂停尾随并提供“有新内容”恢复 | component / browser | `tests/unit/web/chat-stream.test.tsx`（B2 已落地）；浏览器流程仍待 B4：`tests/e2e/web/chat-scroll.spec.ts` | Partial (component accepted) |
| P2-2-06 | 取消传播到 Provider、工具、Session 与 UI | integration / browser | `tests/unit/web/composer.test.tsx`（B2 UI 确认停止已落地）；Provider/工具传播仍待 B1/C1：`tests/e2e/web/cancel.spec.ts` | Partial (UI accepted) |
| P2-2-07 | 审批三种选择精确绑定且重复点击无副作用 | integration / browser | `tests/unit/web/approval.test.tsx`（B2 Fake transport 已落地）；真实 API/浏览器仍待 B1/B4：`tests/e2e/web/approval.spec.ts` | Partial (component accepted) |
| P2-2-08 | 模型/安全模式与 CLI 语义一致，运行中禁用 | unit / browser | `tests/unit/web/composer.test.tsx`（B2 已落地）；浏览器流程仍待 B4：`tests/e2e/web/runtime-settings.spec.ts` | Partial (component accepted) |
| P2-2-09 | Provider 设置只有一个导航页并共用配置服务；发现列表只读且只有默认模型可写 | component / browser | `tests/unit/web/provider-settings.test.tsx`（B2 Fake 发现/校验已落地；真实配置服务 HTTP 仍待 C1）；`tests/e2e/web/provider-settings.spec.ts` | Partial (component accepted) |
| P2-2-10 | API Key 只显示 configured 布尔值且不进入 DOM | API / browser / scan | `tests/unit/web/provider-settings.test.tsx`（B2 DOM 扫描已落地）；API/E2E 仍待 B1/B4：`tests/e2e/web/provider-secret.spec.ts` | Partial (component accepted) |
| P2-2-11 | Session 行使用文字状态、不加图标；创建/恢复返回 `SessionViewDto` | component / API | `tests/unit/web/session-rail.test.tsx`（文字状态与恢复已落地）；HTTP `SessionViewDto` 仍待 B1：`tests/integration/web/session-view.test.ts` | Partial (rail accepted) |
| P2-2-12 | 输入区含模型、`safe/balanced/auto`、只读上下文用量；运行时发送禁用、停止在提示条 | component / browser | `tests/unit/web/composer.test.tsx`（B2 确认停止与运行时禁用已落地）；浏览器流程仍待 B4：`tests/e2e/web/runtime-settings.spec.ts` | Partial (composer accepted) |
| P2-2-13 | 顶栏常驻“绿点 + 已连接”或“红点 + 未连接”，并正确反映 API、所选 Session SSE 与重连状态 | component / browser | `tests/unit/web/header-status.test.tsx`（A4 壳层已落地）；真实 SSE 重连仍待 B1/B4：`tests/e2e/web/reconnect.spec.ts` | Partial (header accepted) |
| P2-2-14 | 同一投影不同时显示 Turn 已完成与仍在运行 | projection / component | `tests/unit/web/states.test.tsx` | Accepted |

## 4. P2-3：Trace 与 Inspector

| ID | 强制行为 | 主要测试层 | 计划证据 | 状态 |
| --- | --- | --- | --- | --- |
| P2-3-01 | Trace 只含八类业务记录并按 seq 排序 | projection | `tests/unit/web/trace-projector.test.ts` | Planned |
| P2-3-02 | chunk、内部重试和 reasoning 不形成记录 | projection / scan | `tests/unit/web/trace-privacy.test.ts` | Planned |
| P2-3-03 | 直播、刷新、补页和恢复顺序一致 | integration / browser | `tests/e2e/web/trace-order.spec.ts` | Planned |
| P2-3-04 | 选中记录只展示匹配的结构化 Inspector | component / browser | `tests/unit/web/inspector.test.tsx`, `tests/e2e/web/trace-inspector.spec.ts` | Planned |
| P2-3-05 | Context 显示预算与裁剪，不泄漏完整内容 | projection | `tests/unit/web/context-detail.test.ts` | Planned |
| P2-3-06 | Policy Explain 只消费结构化 decision/rule | projection | `tests/unit/web/policy-detail.test.ts` | Planned |
| P2-3-07 | 文件变化只显示相对路径和 bounded diff | projection / browser | `tests/unit/web/diff-detail.test.ts` | Planned |
| P2-3-08 | Verified 只来源于真实命令终态且不夸大退出码含义 | projection / browser | `tests/unit/web/verification-detail.test.ts` | Planned |
| P2-3-09 | 大型 Trace 分页、虚拟化且上滚不跳动 | component / performance | `tests/e2e/web/trace-large-session.spec.ts` | Planned |
| P2-3-10 | 不注册 Session 导出路由或页面入口 | API / component | `tests/integration/web/routes.test.ts`（A5 已证明无导出路由）；`tests/unit/web/session-actions.test.tsx`（B2 已证明无页面入口） | Accepted |

## 5. P2-4：体验、产物与回归

| ID | 强制行为 | 主要测试层 | 计划证据 | 状态 |
| --- | --- | --- | --- | --- |
| P2-4-01 | 空、加载、断线、resync 和全部终态明确 | component | `tests/unit/web/states.test.tsx`（B2 已覆盖空/加载/断线/resync/失败/取消/运行/审批）；真实 HTTP 失败态仍待 C1 | Partial (component accepted) |
| P2-4-02 | 键盘完成核心流程，焦点与模态返回正确 | component / browser | `tests/e2e/web/keyboard.spec.ts` | Planned |
| P2-4-03 | 状态不只依赖颜色，live region 不逐 token 播报 | accessibility | `tests/e2e/web/accessibility.spec.ts` | Planned |
| P2-4-04 | 200% 缩放、窄屏抽屉和 reduced motion 可用 | browser | `tests/e2e/web/responsive.spec.ts` | Planned |
| P2-4-05 | 构建产物包含 CLI 与 `dist/web/` 静态资源 | artifact | `scripts/smoke-web-artifact.mjs` | Accepted |
| P2-4-06 | 非仓库 cwd 可启动、认证、创建 Session 并关闭 | Windows artifact | `scripts/smoke-web-artifact.mjs` | Planned |
| P2-4-07 | P0/P1 `run`、`chat`、`config` 与 Session 不退化 | regression | existing suite + `pnpm check` | Accepted |
| P2-4-08 | CI 不使用真实 Key/付费 Provider | workflow / scan | `.github/workflows/ci.yml`, scan tests | Accepted |
| P2-4-09 | 截图、trace 与页面通过秘密/身份/路径扫描 | CI evidence | Web artifact scan step | Planned |
| P2-4-10 | 受控真实 Provider 完成 Chat、刷新与 Trace | local acceptance | `scripts/accept-web-provider.mjs` | Planned |
| P2-4-11 | 最终交付树不含临时示意图或说明；权威文档不再依赖这些视觉资产 | docs / review | 收尾提交确认临时 PNG 与说明已移除 | Planned |

## 6. 全局门禁

每个 P2 合并候选至少执行：

```powershell
pnpm check
pnpm eval:offline
pnpm smoke:demo
```

当 Web 脚本落地后，质量门还必须包含：

```powershell
pnpm test:web
pnpm test:web:e2e
pnpm smoke:web-artifact
```

脚本名若在骨架任务中调整，必须同时更新 `package.json`、CI、[testing.md](../testing.md)、本矩阵和
P2 总计划。不得让 CI 与文档各自维护不同命令。

## 7. 最终签收记录

P2 最终验收时补充：

- 合并提交 SHA；
- Windows CI run URL；
- 测试文件数、用例数和覆盖率；
- Web E2E 浏览器与版本；
- 非仓库 cwd 产物 smoke 结果；
- 受控真实 Provider 验收日期与模型（不记录 Key 或私有响应）；
- 双盲人工检查结论；
- 所有矩阵项的 `Accepted` 状态与实际证据路径。
