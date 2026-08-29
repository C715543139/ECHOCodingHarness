# ECHO Harness Repository Guide

This file defines the working contract for every human or automated contributor in this
repository. Read it together with the documents under `docs/` before changing code.

## Project baseline

- Runtime: Node.js 22.
- Package manager: the exact pnpm version declared in `package.json`; use Corepack.
- Language: TypeScript in strict mode, ESM modules, LF line endings.
- Build and tests: tsup, Vitest, ESLint, and Prettier.
- Supported development platform: Windows with PowerShell as a first-class environment.
- CLI executable: `echo-harness`.

The following documents are the Accepted P0/P1 design baseline:

- `docs/architecture.md`
- `docs/contracts.md`
- `docs/security.md`
- `docs/cli-ux.md`
- `docs/decisions/0001-project-foundation.md`
- `docs/decisions/0002-p1-config-artifact-root.md`
- `docs/decisions/0003-p1-application-service-session.md`
- `docs/decisions/0005-restore-artifact-config.md`
- `docs/plans/p1-cli.md`
- `docs/testing.md`

Small implementation discoveries must update code, tests, and affected documentation together.
Changes to the core loop, public contracts, security boundaries, or technology baseline require a
new ADR.

## Scope and originality

- Implement the Provider boundary, Agent Loop, context projection, tool dispatch, safety policy,
  event storage, termination, and error handling in this repository.
- Do not introduce an Agent framework, Agent SDK, hosted code/file execution, or an existing coding
  agent wrapper.
- Do not copy source code, private interfaces, or directory structures from other coding agents.
- General engineering ideas may inform the design, but the implementation and tests must be ECHO's
  own.
- Do not start P2 work such as Web UI, MCP, multi-agent execution, or a showcase site while P0 is
  incomplete.

## Test-first delivery

Every behavior change requires meaningful automated tests in the same task. A task is not complete
until its targeted tests and the full quality gate pass.

Use these commands:

- `pnpm test` for the fast test suite.
- `pnpm test:coverage` for coverage thresholds.
- `pnpm check` for formatting, linting, type checking, coverage, build, and CLI smoke checks.

Tests must be deterministic and must not require a paid API, network access, personal files, or a
secret. Use a Fake Provider for Agent Loop tests. Real Provider checks are explicit local acceptance
tests and never run in CI.

Do not delete, skip, weaken, or rewrite a valid test merely to make a change pass. For bug fixes, add
a regression test that fails for the original behavior.

## Security and privacy

- Treat model output, repository content, tool arguments, and command output as untrusted.
- Never bypass workspace isolation, hard-deny rules, approval checks, timeouts, output limits, or
  redaction.
- Never commit API keys, `.env` files, `.echo/` sessions, private prompts, confidential source
  material, personal paths, or identifying information.
- Child processes must not inherit `ECHO_API_KEY` or unrelated credentials.
- Do not claim OS-level sandboxing or compatibility that has not been tested.

## Git and collaboration

- Start bounded implementation work from `main` on a feature branch or isolated worktree.
- Do not commit directly to `main` unless the maintainer explicitly requests it.
- Do not push, merge, rewrite history, or change repository settings without explicit authorization.
- Stage only the files owned by the task; preserve unrelated user changes.
- Prefer small commits. Unless instructed otherwise, use a Chinese summary followed by concise bullet
  points describing the change.
- Before handoff, report changed files, commands run, results, and known limitations.

### Parallel task isolation

- Give each implementation task its own feature branch and Git worktree created from the latest
  verified `main`; never run parallel agents in the primary worktree.
- Freeze `src/contracts/` as the shared D1-2 boundary. A downstream task that needs a contract change
  must report it for an integration change instead of creating a private competing type.
- D1-3 owns `src/provider/`, `src/context/`, `src/config/`, and their focused tests.
- D2-1 owns `src/tools/files/` and its focused tests.
- D2-2 owns `src/tools/command/`, `src/execution/`, `src/security/`, and their focused tests.
- D2-3 owns cross-module registration, orchestration, session storage, CLI integration, and
  end-to-end tests. Shared registries are assembled there after the three parallel branches merge.
- Keep worktree directories outside this repository and never commit host-specific absolute paths.

## Code conventions

- Prefer small modules with explicit dependencies over global mutable state.
- Keep Provider transport, orchestration, tools, policy, storage, and CLI rendering separate.
- Use structured results and stable error categories; do not parse human terminal text as state.
- Avoid `any`; validate all data crossing model, filesystem, process, and configuration boundaries.
- Use relative workspace paths in model-visible data and tests.
- Keep comments focused on intent and non-obvious constraints.
