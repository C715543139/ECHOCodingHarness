# P0 非交互 CLI 演示

> 状态：Ready for recording
>
> 版本：2.0
>
> 最后更新：2026-08-31

本文保留两分钟 CLI 失败测试修复故事，并补充 P2 本地 Web 控制台展示节拍。两者都使用真实产品
输出，不为视频维护第二套渲染。

## 1. 一键 reset

在仓库根目录执行：

```powershell
node scripts/demo-reset.mjs
```

该命令把 [fixtures/demo/src/parse-report.ts](../fixtures/demo/src/parse-report.ts) 和 [fixtures/demo/test/parse-report.test.ts](../fixtures/demo/test/parse-report.test.ts) 恢复为 `fixtures/demo/golden/` 中的失败状态。测试文件被 Agent 改动时，同样用这条命令还原。

reset 后在 fixture 工作区验证失败：

```powershell
Set-Location fixtures/demo
npm test
```

预期：退出码非 0，`parseReport counts failed tests in the total` 失败，`total` 实际为 12、期望为 13。

## 2. Demo prompt

[fixtures/demo/prompt.txt](../fixtures/demo/prompt.txt) 的固定目标：

```text
Fix the failing parser tests in this workspace. Do not modify any test files or anything under test/. Inspect with search_text and read_file, run npm test to observe the failure, change only src/parse-report.ts with apply_patch, then run npm test again until it passes. Use tool results as evidence and stop when the tests pass.
```

禁止 Agent 修改测试的约束同时写在 prompt、`fixtures/demo/AGENTS.md` 和 CLI 系统提示中。

## 3. 录制命令

先构建，再非交互运行。工作区必须是 demo fixture，安全模式使用 `balanced`，以便 `apply_patch` 与 `npm test` 可自动执行：

```powershell
pnpm build
node scripts/demo-reset.mjs
$goal = (Get-Content -Raw .\fixtures\demo\prompt.txt).Trim()
node .\dist\cli.js run $goal --workspace .\fixtures\demo --safety-mode balanced --non-interactive --no-color --max-steps 12
```

真实 Provider 凭据只从环境或仓库外 `.env.test` 注入，不得写入仓库、终端标题或视频画面。

## 4. 预期步骤

固定故事必须在同一连续 Turn 中出现：

1. **检查**：`Step` 标题后出现 `search_text` / `read_file`，路径为相对路径，例如 `src/parse-report.ts`。
2. **失败测试**：`TOOL` `run_command` 与 `COMMAND` `npm test` 后为 `RESULT` `FAIL | exit 1`，并带测试摘要（例如 `1 test failed`）。`exit 1` 只表示验证命令失败，不是 Turn 完成。
3. **定位**：从失败摘要和 `read_file` 结果看到 `total: passed` 未计入失败数。
4. **apply_patch**：`TOOL` `apply_patch` 与 `TARGET` `src/parse-report.ts` 后为 `RESULT` `OK`、相对路径、`+N -M` 与有界 diff。
5. **复测成功**：再次 `npm test` 为 `RESULT` `OK | exit 0` 与通过摘要。
6. **结束**：stdout 为模型最终答复；stderr 为 `Run completed`，含 `STEPS`、`TOOLS`、`CHANGES` 与 `VERIFIED | npm test | exit 0`。进程退出码为 0。

真实输出不得为匹配本文而伪造 Step 数、测试数量或成功结果。

## 5. 失败定位方法

不要解析人类可读终端文本作为 Agent 状态。定位失败使用结构化事实：

- CLI：`RESULT | FAIL | exit 1 | <duration>` 与下一行测试摘要。
- 工具元数据：`run_command` 的 `exitCode`、`durationMs`、截断标记。
- 测试证据：Node test runner 的 `# fail` / `# pass` 行。
- 代码：`src/parse-report.ts` 中 `total: passed` 应为 `total: passed + failed`。
- 会话：`.echo/sessions/*.jsonl` 中对应 `tool.completed` 事件；演示复盘只展示相对路径与事件类型。

## 6. CLI 应展示与不得展示

应能区分：模型文本（`ECHO`）、工具请求（`TOOL`）、审批（`APPROVAL`）、结果（`RESULT` 中的 `OK`/`FAIL`）、错误、独立 `Step` 标题、文件变更、测试摘要。应展示相对路径、结构化结果、diff、退出码和 `Run completed` / `REASON`。

不得展示：推理原文、绝对用户路径、账号或 API Key。非 TTY 或 `--no-color` 时不得含 ANSI。进度在 stderr，最终答复在 stdout。

## 7. 备用录制方案

1. 颜色压缩影响可读时，使用上面的 `--no-color` 命令重录。
2. 模型改了测试、用了 `write_file` 或跳过复测：执行 `node scripts/demo-reset.mjs` 后整段重录，不剪接两次 Turn 冒充连续故事。
3. 瞬时 Provider 失败或上游 503：reset 后再跑，最多三次受控验收；只记录成功/失败、时长和非敏感统计，不保存模型正文。演示命令必须是 `npm test`；`node --test` 不在默认允许的验证命令中，非交互下会被拒绝。
4. 审批打断：确认使用 `--non-interactive` 与 `balanced`；`safe` 会在写入时拒绝。
5. 终端标题、提示符、通知或滚动区出现用户目录/密钥：该镜不可用。
6. 真实 Provider 不可用时，自动化 Fake Provider 故事测试仍证明渲染与闭环，但不能代替演示视频中的真实模型镜头。

本地三次受控验收（需已配置 Provider 环境，且已 `pnpm build`）：

```powershell
node scripts/demo-accept.mjs
```

若 `.env.test` 不在当前 worktree，可在不打印内容的前提下设置 `ECHO_ENV_FILE` 指向仓库外的环境文件。脚本只打印每轮 pass/fail、时长、退出码、`stopReason` 和故事节拍布尔值。

## 8. 已验证基线

2026-08-29 在本机用 `.env.test` 注入的受控 OpenAI-compatible 服务上连续运行 3 次，均以退出码 0 完成，耗时分别约为 23.3 秒、16.9 秒和 16.1 秒。三轮都包含失败测试、`apply_patch`、成功复测与 `completed` 终态，且未发现 API Key、个人绝对路径或推理字段泄露。同日 `pnpm smoke:provider`（`ECHO_RUN_PROVIDER_SMOKE=1`）也通过。该结果证明当前命令与 fixture 可用于录制；最终视频仍须按第 6 节执行人工双盲检查。密钥未写入配置文件、未进入 CI、也未出现在本记录中。

## 9. P2 Web 控制台展示

先完成显式受控验收，再录制：

```powershell
pnpm build
pnpm accept:web-provider
node .\dist\cli.js web --workspace .
```

建议镜头依次覆盖：一次性 bootstrap 后的固定工作区；创建 Session；流式 Chat；运行中禁用发送与
停止入口；三种审批；刷新后恢复聚合消息；Trace 的 user/agent/context/tool/policy/diff/
verification/turn 八类记录；Inspector 的 bounded 参数、结果和关联；Provider 设置只显示
`apiKeyConfigured`。不得展示 bootstrap token、Key、绝对用户路径、原始 JSONL 或隐藏推理。

真实实现静态展示图是 [echo-web-console.png](./assets/echo-web-console.png)。2026-08-31 的受控 Web
验收使用 `deepseek/deepseek-v4-flash`，Chat、SSE 终态、恢复和 Trace 在 4003 ms 内通过；记录不含
Key 或模型响应正文。

### English introduction

> ECHO Harness is a local-first coding agent built from an explicit TypeScript agent loop rather
> than an agent framework. Its Windows-first CLI and loopback-only Web console share the same
> application service, safety policy, bounded tools, and redacted JSONL sessions. The Web console
> adds resumable Chat, approvals, Provider settings, and an explainable Trace/Inspector view while
> keeping API keys, absolute personal paths, raw reasoning, and unbounded tool output out of browser
> DTOs. Deterministic Fake Provider tests, Playwright accessibility and stress scenarios, isolated
> artifact smoke tests, fail-closed privacy scans, and an explicit non-CI real-Provider check make
> the evidence reproducible without putting paid credentials into CI.
