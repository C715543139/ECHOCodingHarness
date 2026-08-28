# Testing ECHO Harness

> 状态：Accepted
>
> 版本：1.0
>
> 最后更新：2026-08-28

## Automated quality gate

Run `pnpm check` for formatting, linting, type checking, coverage, build, CLI/provider
smoke (the latter skipped unless explicitly enabled), and secret/identity scans. Tests
and evals use the deterministic `FakeProvider`; CI does not contact a paid model service,
does not set `ECHO_API_KEY`, and does not require network access.

Useful focused commands:

```powershell
pnpm test
pnpm test:coverage
pnpm eval
pnpm eval:offline
pnpm smoke:demo
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

1. runs `pnpm check` (format, lint, typecheck, coverage, build, CLI/provider smoke, scans);
2. reruns offline evals, demo-loop smoke, secret scan, dual-blind scan, and known-malicious
   sample self-tests as named evidence steps.

CI must not set `ECHO_API_KEY`, `ECHO_RUN_PROVIDER_SMOKE`, or any paid provider URL. The
default `scripts/smoke-provider.mjs` path prints that it was skipped and exits 0.

## Real OpenAI-compatible Provider smoke check

The real Provider smoke check is disabled by default. Build first, then explicitly enable one
bounded request from PowerShell:

```powershell
$env:ECHO_RUN_PROVIDER_SMOKE = '1'
$env:ECHO_BASE_URL = 'https://provider.example/v1'
$env:ECHO_API_KEY = '<secret>'
$env:ECHO_MODEL = '<model>'
pnpm build
pnpm smoke:provider
```

The script requires all three Provider settings, disables retries, limits output, applies a
60-second abort timeout, and never prints the key or model response. Remove the API key from the
shell environment after the check. This path is local acceptance only and is not part of CI.

## Known gaps

- PowerShell is not an OS sandbox; approved commands may still touch the network or files
  outside the workspace. Scans and policy tests reduce risk, they do not prove containment.
- Path checks remain subject to TOCTOU races against a local malicious process.
- Real OpenAI-compatible Provider compatibility is a local, explicit smoke check only.
- Session crash recovery beyond best-effort JSONL terminal repair is out of P0.
- The interactive CLI demonstration fixture (resettable TypeScript failure) is owned by D3-1;
  this branch proves the equivalent loop with Fake Provider evals.
- Dual-blind automation is an aid. Final submission still needs a human pass over Git metadata,
  screenshots, and local paths.
