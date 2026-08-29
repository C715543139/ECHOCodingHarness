# ECHO Harness

**Execution · Context · Harness · Orchestration**

A lightweight, local-first autonomous coding agent built from scratch.

ECHO Harness is a Windows-first TypeScript CLI that connects to an OpenAI-compatible model,
runs an explicit Turn/Step agent loop, executes bounded workspace tools, and records redacted
JSONL events. The P0 release focuses on one complete, inspectable coding loop instead of a broad
feature surface.

## Why it is worth inspecting

- **The loop belongs to ECHO.** Provider transport, context projection, tool dispatch, safety,
  termination, and recovery are implemented in this repository rather than delegated to an
  agent framework.
- **Evidence is part of the product.** The CLI separates model text, tool requests, failures,
  diffs, test results, and the final Turn status. A tool succeeding is never presented as proof
  that the whole task succeeded.
- **Windows is a tested platform.** PowerShell discovery, non-console execution, Unicode paths,
  bounded output, timeouts, cancellation, and process-tree termination have automated coverage.
- **Safety is centralized.** Six tools share workspace isolation, validation, approval, hard-deny,
  redaction, timeout, and output-limit rules.
- **Quality is reproducible.** Fake Provider evals, a resettable failing-test fixture, coverage
  thresholds, malicious scan samples, and a Windows GitHub Actions gate provide reviewable evidence.

## Architecture

```text
CLI / demo
   |
   v
Agent Loop -----> Context Projector -----> OpenAI-compatible Provider
   |                    ^
   |                    |
   +----> Safety Policy +----> redacted JSONL Session Store
   |
   +----> Tool Registry ----> files / PowerShell
```

The six P0 tools are `list_files`, `search_text`, `read_file`, `write_file`, `apply_patch`, and
`run_command`. Tool calls execute sequentially so state changes, approvals, and terminal events
remain deterministic.

## Requirements

- Windows with PowerShell
- Node.js 22
- Corepack and the repository-pinned `pnpm@11.24.0`
- An OpenAI-compatible endpoint, API key, and model name for real runs

## Install

```powershell
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

## Configure

The current `echo-harness run` still uses the P0 merge order: CLI arguments, environment
variables, project configuration, user configuration, then built-in defaults. Credentials are
read from the process environment. ECHO does not automatically load `.env` files, and a
configuration file cannot provide an API key.

```powershell
$env:ECHO_BASE_URL = 'https://provider.example/v1'
$env:ECHO_API_KEY = '<secret>'
$env:ECHO_MODEL = '<model>'
$env:ECHO_SAFETY_MODE = 'balanced'
```

Non-secret defaults may instead be placed in `echo.config.json` or `.echo-config.json`:

```json
{
  "baseUrl": "https://provider.example/v1",
  "model": "example-model",
  "safetyMode": "balanced",
  "maxSteps": 24
}
```

P1-2A replaces that lookup with a single file at `<artifact-root>/config/echo.config.json`.
`artifact-root` is derived from the CLI module or executable, never `process.cwd()`. After that
cutover, `ECHO_API_KEY` remains the only supported secret environment variable; `ECHO_BASE_URL`,
`ECHO_MODEL`, and `ECHO_SAFETY_MODE` are removed. See [ADR-0002](docs/decisions/0002-p1-config-artifact-root.md).

## Run

```powershell
node .\dist\cli.js run "Inspect the project and fix the failing tests." `
  --workspace . `
  --safety-mode balanced `
  --non-interactive `
  --no-color
```

Use `node .\dist\cli.js run --help` for the complete option list. Progress and diagnostics go to
stderr; the final model answer goes to stdout. Exit codes distinguish configuration, Provider,
tool, policy, limit, and cancellation failures.

## Resettable demonstration

The fixed demo shows one continuous story: inspect code, observe a failing TypeScript test, locate
the bug, apply a source-only patch, rerun the test, and finish with evidence.

```powershell
pnpm build
node scripts/demo-reset.mjs
$goal = (Get-Content -Raw .\fixtures\demo\prompt.txt).Trim()
node .\dist\cli.js run $goal `
  --workspace .\fixtures\demo `
  --safety-mode balanced `
  --non-interactive `
  --no-color `
  --max-steps 12
```

The real-Provider acceptance helper runs the story three times when credentials are explicitly
available:

```powershell
node scripts/demo-accept.mjs
```

See [docs/demo.md](docs/demo.md) for reset, expected beats, privacy checks, and recording fallbacks.

## Quality gate

```powershell
pnpm check
pnpm eval:offline
pnpm smoke:demo
```

`pnpm check` runs formatting, linting, strict type checking, coverage, build, CLI smoke, secret
scan, identity scan, and generated malicious-sample self-tests. CI uses only the deterministic
Fake Provider and never receives a real API key. Details and the coverage matrix are in
[docs/testing.md](docs/testing.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Core contracts](docs/contracts.md)
- [Security model](docs/security.md)
- [CLI UX](docs/cli-ux.md)
- [Demo guide](docs/demo.md)
- [Testing and evals](docs/testing.md)
- [ADR-0001: project foundation](docs/decisions/0001-project-foundation.md)
- [ADR-0002: P1 config and artifact-root](docs/decisions/0002-p1-config-artifact-root.md)
- [ADR-0003: application service and recoverable sessions](docs/decisions/0003-p1-application-service-session.md)
- [P1 CLI plan](docs/plans/p1-cli.md)
- [P2 local WebUI plan](docs/plans/p2-webui.md)

## Honest limits

- ECHO is not an operating-system sandbox. Approved PowerShell commands can still access network
  or files permitted to the current user.
- The current release does not provide Web UI, MCP, multi-agent execution, or a
  general rollback system. Application-service session create/resume exists after P1-1A;
  `chat` remains scheduled for P1-1B.
- Compatibility is verified against a bounded OpenAI-compatible service configuration, not every
  provider implementation.
- Model requests may contain repository excerpts selected by the Context Projector. Use ECHO only
  with code and services you are authorized to process.
- Automated redaction and scans reduce disclosure risk but do not replace human review of Git
  metadata, screenshots, terminal chrome, and submission materials.
