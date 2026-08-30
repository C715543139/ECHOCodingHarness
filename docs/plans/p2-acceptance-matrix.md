# P2 需求、测试与验收证据矩阵

> 状态：Accepted
>
> 版本：2.0
>
> 最后更新：2026-08-31

## 1. 用法

本矩阵把 [P2 总计划](./p2-webui.md)、[Web API](../web-api.md) 和
[WebUI 规格](../web-ui.md) 转换为可交付检查项。实现任务必须在同一提交中补充对应自动化测试；集成
任务只负责共享装配和跨模块故事，不替代所有者的聚焦测试。

证据列是最终实现中的测试或脚本位置。所有条目均已通过 2026-08-31 完整质量门；实现调整路径时
仍必须同步更新本矩阵。

## 2. P2-1：服务、配置与 API

| ID | 强制行为 | 主要测试层 | 计划证据 | 状态 |
| --- | --- | --- | --- | --- |
| P2-1-01 | `web` 只监听 `127.0.0.1` 并报告实际端口；默认打开已验证 bootstrap URL，`--no-open` 只打印 | integration / artifact | `tests/integration/web/server-lifecycle.test.ts`, `tests/unit/cli/web.test.ts`, `scripts/smoke-web-artifact.mjs` | Accepted |
| P2-1-02 | 工作区启动时固定，API 不接受路径 | API security | `tests/integration/web/workspace-boundary.test.ts` | Accepted |
| P2-1-03 | 一次性 bootstrap 兑换 HttpOnly Strict Cookie | API security | `tests/integration/web/auth.test.ts` | Accepted |
| P2-1-04 | 精确 Host/Origin、无 CORS、JSON content-type 与 CSP | API security | `tests/integration/web/request-guard.test.ts` | Accepted |
| P2-1-05 | DTO 不含秘密、绝对路径、堆栈或 reasoning | unit / scan | `tests/unit/web/dto-redaction.test.ts`, `tests/unit/web/trace-privacy.test.ts`, `tests/integration/web/production-assembly.test.ts` | Accepted |
| P2-1-06 | CLI/Web 共用配置 Schema、artifact-root 与原子写入 | unit / integration | `tests/unit/config/config-service.test.ts`, `tests/integration/web/production-assembly.test.ts` | Accepted |
| P2-1-07 | 自动发现显式执行、不自动保存、错误脱敏 | integration | `tests/integration/web/provider-discovery.test.ts` | Accepted |
| P2-1-08 | 整个进程最多一个活动 Turn | application / API | `tests/unit/application/active-turn-coordinator.test.ts`, `tests/integration/web/turns.test.ts`, `tests/integration/web/security-fixture.test.ts` | Accepted |
| P2-1-09 | 相同 requestId 重放同一响应且不重复副作用；不同请求指纹返回幂等冲突 | contract / integration | `tests/unit/web/idempotency.test.ts`, `tests/integration/web/idempotency.test.ts`, `tests/integration/web/production-assembly.test.ts` | Accepted |
| P2-1-10 | SSE 判别联合、backlog 与 live 无缝衔接并按 seq 去重 | contract / integration | `tests/unit/web/sse-contract.test.ts`, `tests/unit/web/sse-hub.test.ts`, `tests/integration/web/sse.test.ts`, `tests/integration/web/sse-race.test.ts` | Accepted |
| P2-1-11 | 无法连续补齐时显式 resync，不重放 POST | integration / browser | `tests/integration/web/sse-resync.test.ts`, `tests/unit/web/http-transport.test.ts`, `tests/e2e/web/reconnect.spec.ts` | Accepted |
| P2-1-12 | 关闭时取消活动 Turn，10 秒内清理或非零退出 | integration / artifact | `tests/integration/web/shutdown.test.ts`, `scripts/smoke-web-artifact.mjs`, `scripts/smoke-web-isolated-artifact.mjs` | Accepted |
| P2-1-13 | 每种 Policy 结论持久化稳定 rule ID 与原因，旧 Session 可读 | contract / session | `tests/unit/security/policy-explain.test.ts` | Accepted |
| P2-1-14 | 进程级 Cookie 只允许一条 SSE，heartbeat 不推进 seq | integration | `tests/integration/web/sse-ownership.test.ts`, `tests/integration/web/sse.test.ts`, `tests/integration/web/sse-race.test.ts` | Accepted |
| P2-1-15 | 能力状态表与写操作响应 DTO 在空闲、活动 Session、其它 Session 和关闭状态一致 | contract / API | `tests/unit/web/runtime-capabilities.test.ts`, `tests/unit/web/dto-redaction.test.ts`, `tests/integration/web/runtime-capabilities.test.ts` | Accepted |

## 3. P2-2：Session、Chat 与设置

| ID | 强制行为 | 主要测试层 | 计划证据 | 状态 |
| --- | --- | --- | --- | --- |
| P2-2-01 | Session 分页、新建、恢复和状态显示 | component / browser | `tests/unit/web/session-rail.test.tsx`, `tests/integration/web/session-view.test.ts`, `tests/unit/web/http-transport.test.ts`, `tests/e2e/web/session-flow.spec.ts` | Accepted |
| P2-2-02 | 活动 Turn 时可浏览其他 Session，但不可并发提交 | component / browser | `tests/unit/web/composer.test.tsx`, `tests/unit/web/session-rail.test.tsx`, `tests/unit/application/active-turn-coordinator.test.ts`, `tests/unit/web/http-transport.test.ts` | Accepted |
| P2-2-03 | Chat 历史只从聚合 `model.text` 恢复 | projection / browser | `tests/unit/web/chat-projection.test.ts`, `tests/unit/web/http-transport.test.ts`, `scripts/accept-web-provider.mjs` | Accepted |
| P2-2-04 | 流式正文更新稳定记录，不创建 chunk DOM 行 | component / stress | `tests/unit/web/chat-stream.test.tsx`, `tests/unit/web/http-transport.test.ts` | Accepted |
| P2-2-05 | 上滚暂停尾随并提供“有新内容”恢复 | component / browser | `tests/unit/web/chat-stream.test.tsx` | Accepted |
| P2-2-06 | 取消传播到 Provider、工具、Session 与 UI | integration / browser | `tests/integration/web/turns.test.ts`, `tests/unit/web/composer.test.tsx`, `tests/unit/web/http-transport.test.ts` | Accepted |
| P2-2-07 | 审批三种选择精确绑定且重复点击无副作用 | integration / browser | `tests/integration/web/turns.test.ts`, `tests/unit/web/approval.test.tsx`, `tests/e2e/web/approval.spec.ts` | Accepted |
| P2-2-08 | 模型/安全模式与 CLI 语义一致，运行中禁用 | unit / browser | `tests/integration/web/runtime-capabilities.test.ts`, `tests/unit/web/composer.test.tsx`, `tests/unit/web/http-transport.test.ts` | Accepted |
| P2-2-09 | Provider 设置只有一个导航页并共用配置服务；发现列表只读且只有默认模型可写 | component / browser | `tests/unit/web/provider-settings.test.tsx`, `tests/integration/web/production-assembly.test.ts`, `tests/unit/web/http-transport.test.ts` | Accepted |
| P2-2-10 | API Key 只显示 configured 布尔值且不进入 DOM | API / browser / scan | `tests/unit/web/provider-settings.test.tsx`, `tests/integration/web/production-assembly.test.ts`, `tests/e2e/web/provider-secret.spec.ts`, `scripts/scan-web-artifacts.mjs` | Accepted |
| P2-2-11 | Session 行使用文字状态、不加图标；创建/恢复返回 `SessionViewDto` | component / API | `tests/unit/web/session-rail.test.tsx`, `tests/integration/web/session-view.test.ts`, `tests/integration/web/security-fixture.test.ts` | Accepted |
| P2-2-12 | 输入区含模型、`safe/balanced/auto`、只读上下文用量；运行时发送禁用、停止在提示条 | component / browser | `tests/unit/web/composer.test.tsx`, `tests/unit/web/http-transport.test.ts` | Accepted |
| P2-2-13 | 顶栏常驻“绿点 + 已连接”或“红点 + 未连接”，并正确反映 API、所选 Session SSE 与重连状态 | component / browser | `tests/unit/web/header-status.test.tsx`, `tests/unit/web/http-transport.test.ts`, `tests/e2e/web/reconnect.spec.ts` | Accepted |
| P2-2-14 | 同一投影不同时显示 Turn 已完成与仍在运行 | projection / component | `tests/unit/web/states.test.tsx` | Accepted |

## 4. P2-3：Trace 与 Inspector

| ID | 强制行为 | 主要测试层 | 计划证据 | 状态 |
| --- | --- | --- | --- | --- |
| P2-3-01 | Trace 只含八类业务记录并按 seq 排序 | projection | `tests/unit/web/trace-projector.test.ts`, `tests/integration/web/production-assembly.test.ts` | Accepted |
| P2-3-02 | chunk、内部重试和 reasoning 不形成记录 | projection / scan | `tests/unit/web/trace-privacy.test.ts`, `tests/unit/web/trace-redaction.test.ts`, `scripts/accept-web-provider.mjs` | Accepted |
| P2-3-03 | 直播、刷新、补页和恢复顺序一致 | integration / browser | `tests/unit/web/trace-upsert.test.ts`, `tests/unit/web/http-transport.test.ts`, `tests/integration/web/production-assembly.test.ts`, `scripts/accept-web-provider.mjs` | Accepted |
| P2-3-04 | 选中记录只展示匹配的结构化 Inspector | component / browser | `tests/unit/web/inspector.test.tsx`, `tests/integration/web/production-assembly.test.ts`, `tests/unit/web/http-transport.test.ts` | Accepted |
| P2-3-05 | Context 显示预算与裁剪，不泄漏完整内容 | projection | `tests/unit/web/context-detail.test.ts` | Accepted |
| P2-3-06 | Policy Explain 只消费结构化 decision/rule | projection | `tests/unit/web/policy-detail.test.ts` | Accepted |
| P2-3-07 | 文件变化只显示相对路径和 bounded diff | projection / browser | `tests/unit/web/diff-detail.test.ts` | Accepted |
| P2-3-08 | Verified 只来源于真实命令终态且不夸大退出码含义 | projection / browser | `tests/unit/web/verification-detail.test.ts` | Accepted |
| P2-3-09 | 大型 Trace 分页、虚拟化且上滚不跳动 | component / performance | `tests/unit/web/inspector.test.tsx`, `tests/unit/web/trace-upsert.test.ts`, `tests/e2e/web/trace-large-session.spec.ts` | Accepted |
| P2-3-10 | 不注册 Session 导出路由或页面入口 | API / component | `tests/integration/web/routes.test.ts`（A5 已证明无导出路由）；`tests/unit/web/session-actions.test.tsx`（B2 已证明无页面入口） | Accepted |

## 5. P2-4：体验、产物与回归

| ID | 强制行为 | 主要测试层 | 计划证据 | 状态 |
| --- | --- | --- | --- | --- |
| P2-4-01 | 空、加载、断线、resync 和全部终态明确 | component | `tests/unit/web/states.test.tsx`, `tests/unit/web/http-transport.test.ts` | Accepted |
| P2-4-02 | 键盘完成核心流程，焦点与模态返回正确 | component / browser | `tests/e2e/web/keyboard.spec.ts` | Accepted |
| P2-4-03 | 状态不只依赖颜色，live region 不逐 token 播报 | accessibility | `tests/e2e/web/accessibility.spec.ts` | Accepted |
| P2-4-04 | 200% 缩放、窄屏抽屉和 reduced motion 可用 | browser | `tests/e2e/web/responsive.spec.ts` | Accepted |
| P2-4-05 | 构建产物包含 CLI 与 `dist/web/` 静态资源 | artifact | `scripts/smoke-web-artifact.mjs` | Accepted |
| P2-4-06 | 非仓库 cwd 可启动、认证、创建 Session 并关闭 | Windows artifact | `scripts/smoke-web-isolated-artifact.mjs` | Accepted |
| P2-4-07 | P0/P1 `run`、`chat`、`config` 与 Session 不退化 | regression | existing suite + `pnpm check` | Accepted |
| P2-4-08 | CI 不使用真实 Key/付费 Provider | workflow / scan | `.github/workflows/ci.yml`, scan tests | Accepted |
| P2-4-09 | 截图、trace 与页面通过秘密/身份/路径扫描 | CI evidence | `scripts/scan-web-artifacts.mjs`, `.github/workflows/ci.yml`（失败证据只在 fail-closed 扫描成功后上传） | Accepted |
| P2-4-10 | 受控真实 Provider 完成 Chat、刷新与 Trace | local acceptance | `scripts/accept-web-provider.mjs`, 2026-08-31 `deepseek/deepseek-v4-flash` | Accepted |
| P2-4-11 | 最终交付树不含临时示意图或说明；权威文档不再依赖这些视觉资产 | docs / review | `docs/assets/echo-web-console.png`, `README.md`；说明与引用在 C3 移除，`docs/plans/p2-webui-demo/` 的三张 PNG 在 P2.5 视觉重构完成后删除 | Accepted |

## 6. 全局门禁

每个 P2 合并候选至少执行：

```powershell
pnpm check
pnpm eval:offline
pnpm smoke:demo
```

Web 质量门还包含：

```powershell
pnpm test:web
pnpm test:web:e2e
pnpm smoke:web-artifact
```

脚本名若在骨架任务中调整，必须同时更新 `package.json`、CI、[testing.md](../testing.md)、本矩阵和
P2 总计划。不得让 CI 与文档各自维护不同命令。

## 7. 最终签收记录

- 本地候选：2026-08-31，Windows 10；当前改动未提交，因此没有可填写的合并 SHA 或远程 CI URL；
- `pnpm check`：117 个测试文件、637 项测试通过；
- 覆盖率：statements 85.01%、branches 76.94%、functions 89.04%、lines 86.80%；
- Web E2E：Playwright Chromium 9/9 通过，覆盖键盘、无障碍、200% 缩放、窄屏、reduced motion、
  断线恢复、审批、Provider 秘密与 200 条 Trace；
- Windows 非仓库 cwd 隔离产物 smoke：通过；
- 离线评测与 demo smoke：12/12 通过；
- 受控真实 Provider：2026-08-31，`deepseek/deepseek-v4-flash`，生产 Web API Chat、SSE 终态、
  Session 恢复与 Trace 通过，耗时 4003 ms；未记录 Key 或响应正文；
- 隐私证据：secret、identity、Web artifact fail-closed 扫描及恶意样本自检均通过；
- 展示证据：[真实实现截图](../assets/echo-web-console.png) 已复核且不含密钥、个人路径或隐藏推理；
- 所有矩阵项均为 `Accepted`，证据路径见各行。
