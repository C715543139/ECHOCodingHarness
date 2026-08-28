# Testing ECHO Harness

## Automated quality gate

Run `pnpm check` for formatting, linting, type checking, coverage, build, and smoke checks. Tests use
the deterministic `FakeProvider`; CI does not contact a paid model service.

The D2-3 suite covers:

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

Useful focused commands are:

```powershell
pnpm vitest run tests/unit/agent tests/unit/session tests/unit/cli tests/unit/tools/tool-registry.test.ts
pnpm vitest run tests/integration/cli-run.test.ts
```

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
shell environment after the check.
