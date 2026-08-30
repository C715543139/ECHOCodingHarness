# Testing ECHO Harness

> 状态：Accepted
>
> 版本：1.8
>
> 最后更新：2026-08-30

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

## P2 Web quality plan (Phase A implemented; B1 route module landed)

P2 keeps the existing `pnpm check` contract and adds layered Web evidence without making every
unit-test run install or launch a browser. Phase A provides `pnpm test:web`, `pnpm build:web`,
`pnpm smoke:web-artifact`, pinned test dependencies, Fastify injection tests, and the React shell
with Fake transport. P2-B1 adds an independently assembled Session/Turn/approval/SSE route module
under `src/web/server/session-api.ts` with Fastify injection and race tests; C1 still owns wiring
it into `register-routes.ts`. Remaining Playwright and isolated-package artifact evidence in this
section remains a target contract until its owning B/C task lands.

### Fast unit and integration layer

- Web DTO, JSON Schema, RuntimeCapabilities, SSE union, and requestId idempotency tests live under
  `tests/unit/web/` and `tests/unit/contracts/web-schema.test.ts`; three-layer Policy Explain facts
  are covered by `tests/unit/security/policy-explain.test.ts`. These A1 contract tests use
  deterministic fixtures and do not start HTTP routes or pages. Schema tests cover centralized
  bounds, absolute-path names, oversize strings/arrays, unknown fields, and forbidden secret
  properties. Idempotency tests prove concurrent waiters settle on the same terminal response
  without a parameterless abort. P2-1-05 remains Planned until a real projector exists;
- remaining Web DTO and projection tests use deterministic Session fixtures and the `FakeProvider`;
- shared Provider config service tests in `tests/unit/config/config-service.test.ts` prove Web
  `saveProviderSettings` is a restricted Provider merge, CLI `replacePersistentConfig` is a full
  validated replace, artifact-root locking is case-normalized on win32, discovery does not
  auto-save, and merge refuses to overwrite an unreadable or schema-invalid file; HTTP provider
  routes remain a later integration task;
- Fastify injection tests cover the Phase A assembled routes without opening a product TCP client;
  `tests/integration/web/routes.test.ts` proves the packaged shell is served and no export route
  is registered. P2-B1 independently assembles Session API routes in
  `tests/integration/web/session-api-harness.ts`;
- authentication tests cover one-time bootstrap, cookie attributes, exact Host/Origin, no CORS,
  content type, body limits, CSP, and no-store;
- process-wide active-Turn tests cover two Sessions and prove the second cannot submit or mutate
  runtime state while one Turn runs (`tests/unit/application/active-turn-coordinator.test.ts`,
  `tests/integration/web/turns.test.ts`);
- idempotency tests repeat Turn, cancel, approval, and create-session requests, assert one side
  effect and reject the same requestId with a different request fingerprint
  (`tests/integration/web/idempotency.test.ts`);
- SSE tests cover the discriminated payload union, one stream per process authentication Cookie,
  ordered backlog plus live handoff, duplicate seq, disconnect, terminal events, heartbeat that
  does not advance seq, `resync_required`, subscribe-buffer-snapshot-drain races, and concurrent
  `409 STREAM_ACTIVE` before hijack (`tests/unit/web/sse-hub.test.ts`,
  `tests/integration/web/sse.test.ts`, `tests/integration/web/sse-race.test.ts`,
  `tests/integration/web/sse-resync.test.ts`). These prove the independently assembled B1 module;
  production `register-routes.ts` wiring remains C1;
- Trace projection tests exclude chunks and reasoning and preserve stable Turn/Step order.
  P2 does not implement session export.

### React component layer

Vitest, Testing Library, `user-event`, and a DOM environment cover:

- Session rail paging, new Session, restore, and process-wide active state
  (`tests/unit/web/session-rail.test.tsx`, `tests/unit/web/fake-transport.test.ts`);
- Chat aggregate rendering, streaming upsert, paused tail-follow, cancel, and approval
  (`tests/unit/web/chat-projection.test.ts`, `tests/unit/web/chat-stream.test.tsx`,
  `tests/unit/web/approval.test.tsx`, `tests/unit/web/composer.test.tsx`,
  `tests/unit/web/console-isolation.test.tsx`);
- Web Chat/settings extras are injected as a Fake-agnostic `WebConsoleActions` /
  `WebConsoleView` pair. There is no module-level controller; A4 `App.tsx` omits these
  props and controller-owned buttons stay disabled until C1 wires the root;
- model/safety controls and Provider settings validation
  (`tests/unit/web/composer.test.tsx`, `tests/unit/web/provider-settings.test.tsx`);
- no Session export entry (`tests/unit/web/session-actions.test.tsx`);
- persistent header connection text/state dot and reconnect transitions;
- Trace rows, Inspector ownership, bounded code/diff sections, and `Not verified`;
- keyboard operation, focus return, accessible names, live regions, and reduced motion classes;
- empty, loading, offline, reconnect, resync, failed, cancelled, limited, and completed states.

### Browser and artifact layer

Playwright Chromium runs a deliberately small set of critical flows against a built local server:

1. bootstrap and first Session;
2. Fake Provider Chat with an approval and a completed Turn;
3. refresh/reconnect without duplicate execution;
4. browsing another Session while a Turn is active;
5. Trace selection and matching Inspector details;
6. Provider config save without an API Key entering the DOM;
7. keyboard-only critical flow and 200% zoom smoke;
8. graceful shutdown with and without an active Turn.

`echo-harness web` defaults to opening the server-issued, verified loopback bootstrap URL through an
injectable argument-array opener; tests never launch a real browser. `--no-open` prints that same
URL and must not call the opener. Phase A `pnpm smoke:web-artifact` starts the packaged
`dist/cli.js web --no-open` from a temporary cwd, parses the verified `127.0.0.1` bootstrap URL,
redeems the one-time Cookie, fetches `/` and `/api/v1/bootstrap`, and stops the process by closing
non-TTY stdin. Windows does not deliver `SIGTERM` to listeners, so stdin-end is the supported CI
shutdown. The later isolated-package copy smoke remains a B4/C target. It must not rely on
`.env.test`, a paid Provider, or a user profile path.

CI installs the pinned Chromium version only in the Web E2E evidence step and caches it by the
Playwright version. Browser failures save bounded screenshots/traces as CI artifacts only after
secret and identity scanning. P0/P1 CLI tests remain required in the same gate.

P2 local real-Provider acceptance is explicit and non-CI: start the packaged Web console with a
temporary authorized workspace, complete one bounded Chat Turn, refresh/resume it, inspect Trace,
and verify the saved Session. The response body and key are not printed or committed. P2 does not
export sessions from the WebUI.

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
- P1 does not include Web UI, MCP, multi-agent execution, TUI, or multi-Provider profiles.
- P2 Phase A Web scripts, Fastify security skeleton, React shell, and `pnpm smoke:web-artifact`
  exist. Live Session/Turn APIs, Playwright flows, and isolated-package artifact smoke remain
  planned; Phase A acceptance must not be reported as full P2 implementation acceptance.
