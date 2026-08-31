# Testing ECHO Harness

> 状态：Accepted
>
> 版本：2.0
>
> 最后更新：2026-08-31

## Automated quality gate

Run `pnpm check` for formatting, linting, type checking, coverage, build, CLI/provider
smoke (the latter skipped unless explicitly enabled), artifact cwd smoke, Web artifact smoke,
and secret/identity scans. Tests and evals use the deterministic `FakeProvider`; CI does not
contact a paid model service, does not set `ECHO_API_KEY`, and does not require network access.

Useful focused commands:

```powershell
pnpm test
pnpm test:coverage
pnpm test:web
pnpm build:web
pnpm eval
pnpm eval:offline
pnpm smoke:demo
pnpm smoke:artifact
pnpm smoke:web-artifact
pnpm scan
pnpm scan:secrets
pnpm scan:identity
pnpm scan:self-test
pnpm vitest run tests/unit/agent tests/unit/session tests/unit/tools/tool-registry.test.ts
pnpm vitest run tests/integration/file-tools.test.ts tests/integration/tools/run-command.test.ts
```

## Coverage matrix

| Area | Automated evidence |
| --- | --- |
| Provider mapping, retries, cancellation, Fake Provider | `tests/unit/provider/**`; every offline eval uses `FakeProvider` only |
| Context projection, truncation, pairing | `tests/unit/context/**`; demo-loop eval asserts `context.projected` events |
| Six tools in a temporary workspace | `tests/integration/file-tools.test.ts`, `tests/integration/tools/run-command.test.ts`; demo-loop eval executes all six |
| SafetyPolicy modes, hard denies, path escape | `tests/unit/security/command-policy.test.ts`; policy-deny eval |
| Agent Loop stop reasons and tool terminals | `tests/unit/agent/agent-loop.test.ts`; all offline evals |
| JSONL append/read and pre-persistence redaction | `tests/unit/session/jsonl-session-store.test.ts`; demo-loop eval rereads `.echo/sessions/*.jsonl` |
| Cancel, timeout, repeated calls, duplicate tool-call IDs | Agent Loop unit tests, `run_command` integration timeout/cancel; loop-guards eval |
| Temporary workspace isolation | file/command integration tests and evals create `os.tmpdir()` workspaces and delete them |
| P1-0 frozen contracts, config errors, exit codes, paste/slash, artifact-root | `tests/unit/contracts/p1-baseline.test.ts`, `tests/unit/contracts/doc-consistency.test.ts`; each `P1_TEST_MATRIX` row has `contractEvidence` (this freeze) and `runtimeEvidence` (later task or existing P0 tests) |
| P1-2A artifact-root loader and config wizard | `tests/unit/config/**`, `tests/unit/cli/config-wizard.test.ts`, `tests/integration/cli-run.test.ts`; matrix CFG-* rows now point at runtime tests |
| P1-2B `/models` catalog, in-process cache, and fail-open configured model | `tests/unit/provider/model-catalog.test.ts`, `tests/unit/provider/openai-client.test.ts`, `tests/unit/provider/fake-provider.test.ts`, `tests/integration/cli-run.test.ts`; matrix MDL-* rows |
| P1-1B Chat resume, slash, Ctrl+C, paste, and default catalog port | `tests/integration/cli-chat.test.ts`, `tests/unit/cli/parse-chat-input.test.ts`, `tests/unit/cli/chat-input-decoder.test.ts`, `tests/unit/cli/session-id.test.ts`, `tests/unit/config/session-settings.test.ts`; matrix APP-03/CHAT-* rows |
| Chat interrupt of an in-flight `run_command` PowerShell tree | `tests/integration/cli-chat-cancel-command.test.ts` |
| Interactive approval prompt and `n`/`y`/`s` decisions in run/chat | `tests/unit/cli/interactive-approval-handler.test.ts`, `tests/integration/cli-run.test.ts`, `tests/integration/cli-chat.test.ts` |
| P1.5 aggregate text/reasoning events, stop matrix, 256K budget, and `/status` | `P15_TEST_MATRIX` in `src/contracts/p15-matrix.ts`; `tests/unit/provider/reasoning.test.ts`, `tests/unit/agent/agent-loop.test.ts`, `tests/unit/context/event-context-builder.test.ts`, `tests/unit/session/jsonl-session-repository.test.ts`, `tests/unit/session/session-query.test.ts`, `tests/unit/cli/event-renderer.test.ts`, `tests/unit/cli/chat-view.test.ts`, `tests/integration/cli-run.test.ts`, `tests/integration/cli-chat.test.ts` |

P1.5 正文聚合回归必须使用合成 Provider 流覆盖：大量单字符 delta 只产生一条 `model.text`；新 Session 不产生 `model.text_delta`；失败和取消在终态前保存一条 `partial: true` 正文；旧 v1/v2 与修订前本地 v3 增量日志仍可读取、查询、投影和渲染；同一 Step 混用聚合正文与增量正文安全拒绝。推理回归必须覆盖严格 `reasoning.text` 的等价整组省略、details-only canonical `reasoning`、拼接不一致、额外键、encrypted、signature、summary、未知类型、混合数组和空文本整组保留。CLI snapshot 必须证明聚合前后 stdout/stderr、Step 间距和最终摘要不变。

P1-0 增加契约与矩阵测试。矩阵每一行同时记录 `contractEvidence` 与 `runtimeEvidence`；P1 集成验收要求所有 `runtimeEvidence` 都指向真实运行时测试，不得再保留 `pending:<task>`：

| Runtime task | Additional automated evidence |
| --- | --- |
| P1-2A | artifact-root 加载、缺失配置退出码 2、未知键失败、不读取 cwd/工作区 `.echo/config`/`ECHO_BASE_URL`（已落地） |
| P1-2B | `/models` 发现、缓存、失败不阻断已配置模型、CLI `--model` 优先于配置且不发现、手动 `/model refresh` 拒绝。证据：`tests/unit/provider/model-catalog.test.ts`、`tests/unit/provider/openai-client.test.ts`、`tests/integration/cli-run.test.ts`、`tests/integration/cli-help.test.ts` |
| P1-1A | `ApplicationService` 与 Session 查询；`run` 经服务执行且 P0 退出码不变。证据：`tests/unit/application/echo-application-service.test.ts`、`tests/unit/session/jsonl-session-repository.test.ts`、`tests/unit/session/endpoint-fingerprint.test.ts`、`tests/integration/cli-run.test.ts` |
| P1-1B | Chat 恢复、Slash、Ctrl+C、bracketed paste 一次粘贴至多一个 Turn、`/model` 候选校验与目录请求取消：`tests/unit/config/session-settings.test.ts`、`tests/unit/cli/parse-chat-input.test.ts`、`tests/unit/cli/chat-input-decoder.test.ts`、`tests/unit/cli/chat-input-reader.test.ts`、`tests/unit/cli/model-candidates.test.ts`、`tests/unit/cli/session-id.test.ts`、`tests/integration/cli-chat.test.ts`。SESSION 短 ID 恢复与先前用户目标进入投影由 `tests/unit/cli/session-id.test.ts`、`tests/unit/context/event-context-builder.test.ts` 与 Chat 集成测试覆盖；连续相同用户目标用完整消息顺序断言，低预算下当前目标只计费一次，非法 `--resume`（含 `../bad` 与 `..\\bad`）由 Chat 集成测试回归 |
| P1-3 | 分组时间线、组间空行、用户拒绝只渲染一次 `DENIED`、窄宽度/CJK、Chat 启动摘要与状态条间距：`tests/unit/cli/event-renderer.test.ts`、`tests/unit/cli/render-layout.test.ts`、`tests/unit/cli/chat-view.test.ts`；Slash/`/status` 空行由 `tests/integration/cli-chat.test.ts` 回归；非 TTY/`--no-color` 与 stdout/stderr 契约保持 |

`ECHO_API_KEY` 仍不得进入 CI、事件或测试快照。`<artifact-root>/config/echo.config.json` 是 P1 唯一持久配置路径。

The D2-3 suite still covers:

- text-only completion and multi-step tool-result feedback through the Agent Loop;
- sequential dispatch, recoverable tool failures, policy denial, session approval, cancellation,
  maximum steps, and equivalent-call repetition limits;
- exactly one terminal event for every requested tool in tested stop paths;
- one-shot and ambiguous-commit SessionStore fault injection, including best-effort repair without
  duplicate tool or Turn terminals;
- rejection of empty, same-response duplicate, and cross-Step reused tool-call IDs before tool
  request or execution;
- ordered JSONL append/read, invalid session IDs, sequence validation, and pre-persistence
  redaction;
- stdout/stderr routing, verbose/no-color rendering, non-interactive approval denial, stable exit
  codes, and a complete Fake Provider `run` invocation with a persisted session.

## Offline Fake Provider evals

`tests/evals/` records structured `status`, `steps`, `toolCalls`, and `stopReason` values and
asserts a display-ready summary of the form:

```text
EVAL demo-loop
status     completed
steps      7
toolCalls  6
stopReason completed
```

| Eval | What it proves | Expected record |
| --- | --- | --- |
| `demo-loop` | list/search/read/write/patch/`run_command` repair loop, JSONL, context projection | `completed` / 7 steps / 6 tools / `completed` |
| `policy-deny` | hard deny of env export and workspace escape before side effects | `failed` / 1 step / 1 tool / `policy_denied` |
| `loop-guards` | repeated equivalent calls, pre-aborted cancel, duplicate tool-call IDs, command timeout | `limited`+`repeated_tool_call`, `cancelled`, `provider_error`, then a recovered timeout turn |

`pnpm eval` and `pnpm eval:offline` run this suite. `pnpm smoke:demo` reruns only the demo-loop
eval as the quality-owned, fully offline stand-in for a locate-modify-retest demonstration.
CLI demo fixtures under `fixtures/demo/**`, `scripts/demo-*`, and `docs/demo.md` are owned by
D3-1 and are not required for this gate.

`pnpm smoke:artifact` starts the built `dist/cli.js` from a different working directory that
contains decoy `echo.config.json` and `.echo/config/echo.config.json` files, and asserts the
process still reads `<artifact-root>/config/echo.config.json` (or fails closed when that file is
missing). It must not echo `ECHO_API_KEY` or follow cwd / workspace `.echo/config` decoys.

## Secret and dual-blind scans

`pnpm scan:secrets` and `pnpm scan:identity` walk Git-tracked text (or a `--root` directory).
`pnpm scan:self-test` generates known-malicious samples in a temporary directory, expects
those rules to fire, then asserts the repository itself is clean.

Positive samples (generated at runtime, never committed as contiguous secrets):

- OpenAI-shaped `sk-` keys, GitHub `ghp_` tokens, AWS `AKIA` keys, PEM private-key headers,
  and `client_secret=` assignments;
- a personal email and a `C:\Users\<name>\` profile path.

Negative samples live in `tests/evals/scan-samples/**/negative/` and must stay silent:

- empty `ECHO_API_KEY=`, `<secret>` / `your-api-key-here` placeholders, all-`x` tokens,
  and the public AWS example key `AKIAIOSFODNN7EXAMPLE`;
- documented fixture profiles (`fixture`, `private-user`, `private-name`, `runner`,
  `FIXTUR~1`) and `example.com` / `example.test` addresses.

Failure output prints only a repo-relative path, line number, and `rule=` id. It must not
echo the matched secret, a raw email, or an absolute personal profile path.

## CI boundary

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on `windows-latest` with
Node 22, Corepack-pinned pnpm, and `pnpm install --frozen-lockfile`. The job:

1. runs `pnpm check` (format, lint, typecheck, coverage, build, CLI/provider/artifact/Web smoke, scans);
2. reruns offline evals, demo-loop smoke, artifact cwd smoke, Web artifact smoke, secret scan,
   dual-blind scan, and known-malicious sample self-tests as named evidence steps.

CI must not set `ECHO_API_KEY`, `ECHO_RUN_PROVIDER_SMOKE`, or any paid provider URL. The
default `scripts/smoke-provider.mjs` path prints that it was skipped and exits 0.

## Real OpenAI-compatible Provider smoke check

The real Provider smoke check is disabled by default. It talks to the OpenAI-compatible
adapter directly (not through `echo-harness` config merge) using smoke-only `ECHO_BASE_URL` /
`ECHO_MODEL` / `ECHO_API_KEY`. The same bounded request is persisted through one Agent Loop
turn into a temporary workspace Session. The script then reads that Session `.jsonl` and
asserts the P1.5 writer contract: at most one `model.text` per model response, no persisted
`model.text_delta`, and text event envelopes that do not grow with body length.
`scripts/session-text-invariants.mjs` is the shared JSONL checker; Fake Provider evals reuse it
offline. Build first, then explicitly enable one bounded request from PowerShell:

```powershell
$env:ECHO_RUN_PROVIDER_SMOKE = '1'
$env:ECHO_BASE_URL = 'https://provider.example/v1'
$env:ECHO_API_KEY = '<secret>'
$env:ECHO_MODEL = '<model>'
pnpm build
pnpm smoke:provider
```

Those script environment variables are local-acceptance inputs for `scripts/smoke-provider.mjs`.
They are not `echo-harness` configuration sources. `echo-harness run` reads
`<artifact-root>/config/echo.config.json` plus `ECHO_API_KEY` only.

The script requires all three Provider settings, disables retries, limits output, applies a
60-second abort timeout, deletes the temporary workspace afterward, and never prints the key or
model response. Remove the API key from the shell environment after the check. This path is local
acceptance only and is not part of CI. It does not read `.env.test`.

## P2 Web quality plan (C1 production assembly implemented)

P2 keeps the existing `pnpm check` contract and adds layered Web evidence without making every
unit-test run install or launch a browser. Phase A provides `pnpm test:web`, `pnpm build:web`,
`pnpm smoke:web-artifact`, pinned test dependencies, Fastify injection tests, and the React shell
with Fake transport. P2-B1 adds an independently assembled Session/Turn/approval/SSE route module
under `src/web/server/session-api.ts` with Fastify injection and race tests. B2 adds the Session/Chat/
settings component behavior, and B3 adds Trace/Inspector projection and privacy tests. B4 adds
independent Fake Provider Web scenarios, a Fastify security fixture,
Playwright Chromium specs under `tests/e2e/web/`, isolated-package Web artifact smoke, and
screenshot/trace privacy scanning. The scanner reads `error-context.md` and other page artifacts,
fail-closes `trace.zip` as `unscannable-archive`, and fail-closes files larger than 8 MiB as
`oversized-artifact`. C1 wires `pnpm test:web:e2e`, isolated smoke, and the Web artifact scanner
into package scripts and Windows CI. Playwright failure artifacts are uploaded only when the
fail-closed scan step succeeds.

### Fast unit and integration layer

- Web DTO, JSON Schema, RuntimeCapabilities, SSE union, and requestId idempotency tests live under
  `tests/unit/web/` and `tests/unit/contracts/web-schema.test.ts`; three-layer Policy Explain facts
  are covered by `tests/unit/security/policy-explain.test.ts`. These A1 contract tests use
  deterministic fixtures and do not start HTTP routes or pages. Schema tests cover centralized
  bounds, absolute-path names, oversize strings/arrays, unknown fields, and forbidden secret
  properties. Idempotency tests prove concurrent waiters settle on the same terminal response
  without a parameterless abort. C1 production Trace HTTP assembly uses the same B3
  `projectTrace` redaction for secrets, reasoning and absolute paths;
- remaining Web DTO and projection tests use deterministic Session fixtures and the `FakeProvider`;
- shared Provider config service tests in `tests/unit/config/config-service.test.ts` prove Web
  `saveProviderSettings` is a restricted Provider merge, CLI `replacePersistentConfig` is a full
  validated replace, artifact-root locking is case-normalized on win32, discovery does not
  auto-save, and merge refuses to overwrite an unreadable or schema-invalid file. Production
  Provider HTTP route assembly and persisted settings are covered by
  `tests/integration/web/production-assembly.test.ts`; discovery request mapping is covered by
  `tests/unit/web/http-transport.test.ts` and the config-service tests;
- Fastify injection tests cover the Phase A assembled routes without opening a product TCP client;
  `tests/integration/web/routes.test.ts` proves the packaged shell is served and no export route
  is registered. P2-B1 independently assembles Session API routes in
  `tests/integration/web/session-api-harness.ts`;
- authentication tests cover one-time bootstrap, cookie attributes, exact Host/Origin, no CORS,
  content type, body limits, CSP, and no-store;
- process-wide active-Turn tests cover two Sessions and prove the second cannot submit or mutate
  runtime state while one Turn runs (`tests/unit/application/active-turn-coordinator.test.ts`,
  `tests/integration/web/turns.test.ts`);
- Session deletion tests prove exact regular-file deletion, missing-session behavior, idle deletion,
  and the active `cancel -> terminal persistence -> delete` sequence
  (`tests/unit/session/jsonl-session-repository.test.ts`,
  `tests/unit/application/active-turn-coordinator.test.ts`,
  `tests/integration/web/session-delete.test.ts`);
- idempotency tests repeat Turn, cancel, approval, and create-session requests, assert one side
  effect and reject the same requestId with a different request fingerprint
  (`tests/integration/web/idempotency.test.ts`);
- SSE tests cover the discriminated payload union, one stream per process authentication Cookie,
  ordered backlog plus live handoff, duplicate seq, disconnect, terminal events, heartbeat that
  does not advance seq, `resync_required`, subscribe-buffer-snapshot-drain races, and concurrent
  `409 STREAM_ACTIVE` before hijack (`tests/unit/web/sse-hub.test.ts`,
  `tests/integration/web/sse.test.ts`, `tests/integration/web/sse-race.test.ts`,
  `tests/integration/web/sse-resync.test.ts`). C1 also exercises the production
  `register-routes.ts` assembly through the shared security fixture;
- Trace projection tests exclude chunks and reasoning and preserve stable Turn/Step order.
  B3 evidence: `tests/unit/web/trace-projector.test.ts`, `trace-privacy.test.ts`,
  `trace-redaction.test.ts`, `trace-upsert.test.ts`, `context-detail.test.ts`,
  `policy-detail.test.ts`, `diff-detail.test.ts`, `verification-detail.test.ts`,
  `inspector.test.tsx`, plus C1 HTTP list/detail evidence in
  `tests/integration/web/production-assembly.test.ts`.
  P2 does not implement session export.

### React component layer

Vitest, Testing Library, `user-event`, and a DOM environment cover:

- Session rail paging, new Session, restore, confirmed deletion, failure retention, and process-wide active state
  (`tests/unit/web/session-rail.test.tsx`, `tests/unit/web/fake-transport.test.ts`);
- Chat aggregate rendering, streaming upsert, paused tail-follow, terminal positioning at the newest
  Turn start, cancel, and approval
  (`tests/unit/web/chat-projection.test.ts`, `tests/unit/web/chat-stream.test.tsx`,
  `tests/unit/web/approval.test.tsx`, `tests/unit/web/composer.test.tsx`,
  `tests/unit/web/console-isolation.test.tsx`);
- safe model Markdown semantics, plain-text user messages, skipped raw HTML, isolated links, and
  non-loading image placeholders (`tests/unit/web/chat-stream.test.tsx`);
- Web Chat/settings extras are injected as a Fake-agnostic `WebConsoleActions` /
  `WebConsoleView` pair. There is no module-level controller; the production `App.tsx` owns one
  transport instance and passes its actions to the Session rail, Chat view, and Provider settings;
- model/safety controls and Provider settings validation
  (`tests/unit/web/composer.test.tsx`, `tests/unit/web/provider-settings.test.tsx`);
- no Session export entry (`tests/unit/web/session-actions.test.tsx`);
- persistent header connection text/state dot and reconnect transitions;
- Trace rows, Inspector ownership, bounded code/diff sections, and `Not verified`;
- keyboard operation, focus return, accessible names, live regions, and reduced motion classes;
- empty, loading, offline, reconnect, resync, failed, cancelled, limited, and completed states.

### Browser and artifact layer

Playwright Chromium runs 11 deliberately small spec files (13 test cases) against a built local
server. The current P2.5 browser baseline covers:

1. bootstrap without a paid Provider;
2. first Fake Provider Session plus fixed-shell and owned-scroll behavior;
3. approval projection and matching Trace;
4. disconnect, reconnect, and resync without replaying a POST;
5. Provider state without an API Key entering the DOM;
6. keyboard-only operation and focus restoration;
7. 200% zoom, narrow viewport, and reduced motion;
8. safe model Markdown without interpreting user text or loading remote images;
9. confirmed idle deletion and active Turn stop-before-delete behavior;
10. bounded, virtualized rendering of 200 Trace records;
11. landmarks, text status, and polite live-region accessibility.

`echo-harness web` defaults to opening the server-issued, verified loopback bootstrap URL through an
injectable argument-array opener; tests never launch a real browser. `--no-open` prints that same
URL and must not call the opener. Phase A `pnpm smoke:web-artifact` starts the packaged
`dist/cli.js web --no-open` from a temporary cwd, parses the verified `127.0.0.1` bootstrap URL,
redeems the one-time Cookie, fetches `/` and `/api/v1/bootstrap`, and stops the process by closing
non-TTY stdin. Windows does not deliver `SIGTERM` to listeners, so stdin-end is the supported CI
shutdown. B4 adds `scripts/smoke-web-isolated-artifact.mjs`: it copies `dist/*.js`, `dist/web/`, and
minimal `package.json` metadata into a temporary package, starts `web --no-open` from a separate
non-repo cwd, redeems the Cookie, fetches `/` and `/api/v1/bootstrap`, and shuts down via stdin-end.
pnpm and Web child processes receive an explicit Windows env allowlist (`PATH`, `SystemRoot`,
`ComSpec`, `PATHEXT`, `TEMP`, `TMP`, and similar runtime variables). The Web process gets only a
controlled `ECHO_API_KEY`; other `ECHO_*` and common CI/cloud/token/key variables are not inherited.
Windows invokes `pnpm.cmd` with a fixed argument array and `shell: false`. The copied manifest keeps
both dependency sections so it exactly matches the copied lockfile, while
`--prod --offline --frozen-lockfile` installs production dependencies only and never performs a
registry resolution. Temp cleanup failures are reported without expanding the delete scope beyond
that `os.tmpdir()` tree. It does not use source, repository `node_modules`, `.env.test`, or a user
profile workspace. C1 requires the isolated `POST /api/v1/sessions` call to return
`201 SessionViewDto` and wires the script into `pnpm check` / CI. It does not rely on `.env.test`, a
paid Provider, or a user profile path.

CI installs the pinned Chromium version only in the Web E2E evidence step and caches it by the
Playwright version. Browser failures save bounded screenshots/traces as CI artifacts only after
`scripts/scan-web-artifacts.mjs` passes. Findings include secrets, identity, `reasoning_details` /
`reasoningContent` / `model.reasoning`, absolute Windows drive/UNC/`/home`/`/Users` paths,
unscannable zip archives, and oversized files. Scan output must not echo secrets or paths. P0/P1
CLI tests remain required in the same gate.

P2 local real-Provider acceptance is explicit and non-CI: start the packaged Web console with a
temporary authorized workspace, complete one bounded Chat Turn, refresh/resume it, inspect Trace,
and verify the saved Session. The response body and key are not printed or committed. P2 does not
export sessions from the WebUI.

Run it only with authorized credentials:

```powershell
pnpm build
pnpm accept:web-provider
```

The helper loads the environment or gitignored `.env.test`, writes a temporary non-secret
artifact-root config, starts the packaged `dist/cli.js web`, authenticates through the one-time
bootstrap flow, verifies SSE terminal delivery plus restored Chat and Trace DTOs, and restores the
previous config and temporary workspace in `finally`.

The 2026-08-31 C2 historical checkpoint passed `pnpm check` with 117 test files / 637 tests and
coverage of 85.01% statements, 76.94% branches, 89.04% functions, and 86.80% lines. Playwright
Chromium was 9/9 at that checkpoint.

The current P2.5 acceptance baseline passes `pnpm check` with 118 test files / 658 tests and
coverage of 85.09% statements, 76.94% branches, 90.08% functions, and 86.91% lines. Playwright
Chromium is 13/13 across 11 spec files; offline evals remain 11/11 and demo smoke remains 1/1.
Controlled Provider acceptance used `deepseek/deepseek-v4-flash` and completed packaged Web Chat,
SSE terminal delivery, Session recovery, and Trace in 4003 ms without recording the key or
response body.

## Known gaps

- PowerShell is not an OS sandbox; approved commands may still touch the network or files
  outside the workspace. Scans and policy tests reduce risk, they do not prove containment.
- Path checks remain subject to TOCTOU races against a local malicious process.
- Real OpenAI-compatible Provider compatibility is a local, explicit smoke check only.
  2026-08-29 local acceptance loaded `.env.test` (gitignored): `pnpm smoke:provider` passed,
  and `node scripts/demo-accept.mjs` was 3/3 with privacy checks true. Do not copy that file
  or `ECHO_API_KEY` into CI.
- Session crash recovery beyond best-effort JSONL terminal repair is out of P0.
- The interactive CLI demonstration fixture (resettable TypeScript failure) is owned by D3-1;
  this branch proves the equivalent loop with Fake Provider evals.
- Dual-blind automation is an aid. Final submission still needs a human pass over Git metadata,
  screenshots, and local paths.
- Offline evals (`demo-loop`) and PowerShell process-tree assertions (`terminationSucceeded`) can
  time out or fail when many test files run in parallel on a loaded Windows host. Windows Vitest
  therefore uses `maxWorkers: 1`. Sequential `pnpm check` / `pnpm eval:offline` is the quality gate.
  Treat residual contention as a host-load issue, not a catalog or Agent Loop defect, and do not
  weaken the P0 assertions to hide it.
- Hosts without CSI `200~`/`201~` still submit one typed batch per Enter and cannot promise
  multi-line paste atomicity. Chat `/model` consumes the catalog port rather than a second
  `GET /models` implementation.
- P2 does not include remote Web access, MCP, multi-agent execution, TUI, Session export, or
  multi-Provider profiles.
- P2 production assembly, live Session/Turn/Trace APIs, real HTTP/SSE transport, package/CI wiring,
  complete browser quality gates, controlled real-Provider acceptance, and documentation/asset
  cleanup are complete.

## P3 quality plan（A1 Full Access evidence）

`P3_TEST_MATRIX` 位于 `src/contracts/p3.ts`，权威文档是
[p3-acceptance-matrix.md](./plans/p3-acceptance-matrix.md)。A0 使用 `pending:P3-*` 标记后续运行时所有权；
A1–C3 必须逐项补齐存在的测试路径，最终不得保留 pending。P3-A1 专用分支按冻结要求不修改
`src/contracts/p3.ts`；FULL-01/02/03 的真实路径先记录在验收矩阵文档，待共享合同解除冻结后由集成
任务同步可机读矩阵。

P3-A1 自动证据包括：

- `tests/unit/application/full-access.test.ts`：确认门、非法模型来源、同 Session 恢复、撤销与重确认、
  resume 覆盖以及活动 Turn 转换门；
- `tests/unit/cli/full-access-confirmation.test.ts`、`tests/integration/cli-run.test.ts` 与
  `tests/integration/cli-chat.test.ts`：完整风险提示、非交互双旗标、交互拒绝和 Slash 重确认；
- `tests/unit/contracts/web-schema.test.ts` 与 `tests/integration/web/session-view.test.ts`：有界 Web DTO、
  `web-dialog` 来源映射和非 Full Access 携带确认的拒绝；
- `tests/unit/security/command-policy.test.ts` 与 `tests/integration/cli-run.test.ts`：危险命令无逐项审批，
  同时保留命令超时、凭据隔离和内置文件工具工作区边界；
- `tests/integration/tools/run-command.test.ts`、`tests/integration/execution/powershell.test.ts` 与既有
  Agent Loop 测试继续覆盖取消、输出上限和进程树清理，证明 Full Access 未改动这些执行层路径。

P3 继续以 `pnpm check` 为最小门禁，并增加：Full Access 的确认与三旧模式回归；Manifest/Catalog
Schema、原子写与工作区隔离；Worker 超时、取消、崩溃、协议和凭据继承；动态 Registry 的下一模型
请求边界；七个生命周期工具和故障注入；Web 风险确认、常驻 FULL ACCESS、扩展管理与无障碍；独立
产物从非仓库 cwd 加载扩展；Fake Provider 跨 Session 故事；合成 PDF 的失败/成功控制、受保护输入
哈希和 Harness 外独立复验。

真实 Provider/PDF 验收显式本地运行，不进入 CI，不打印模型正文或凭据。普通命令 `exitCode=0` 仍只
表示该命令成功；只有哈希未变且独立复验通过，UI/文档才可以写“可信验收通过”。

### P3-A2 storage evidence

- `tests/unit/extensions/manifest.test.ts`：Manifest v1 往返、未知字段、名称/版本/数量上限、严格工具
  JSON Schema、路径正规化和内置/生命周期/扩展间工具冲突；
- `tests/unit/extensions/content-hash.test.ts`：当前工作区固定目录、规范文件集合 SHA-256、内容变化、
  根逃逸以及 symlink/junction 拒绝；
- `tests/unit/extensions/catalog.test.ts`：三种冻结状态、revision、损坏与未知版本、哈希篡改、Catalog
  链接、原子替换故障、陈旧 revision 和不确定恢复失败关闭；
- `tests/unit/extensions/workspace-isolation.test.ts`：两个临时工作区互不可见、Store API 不接受外部根、
  canonical workspace 在 alias/junction 改指后保持固定、目录身份替换失败关闭，并验证 `.echo/` Git
  忽略。

P3-A2 不加载或执行扩展代码，不实现 Worker、动态 Registry、七个 `extension_*` 生命周期工具或 Web
接线。由于 A1/A2 并行期冻结 `src/contracts/p3.ts`，EXT-01/02 的上述真实证据先记录于文档，待集成
任务统一替换其中的 `pending:P3-A2`。
