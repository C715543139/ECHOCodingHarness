# Demo workspace

This workspace is a fixed failing-test fixture for `echo-harness run`.

- Change `src/parse-report.ts` only.
- Do not modify `test/`, `golden/`, `prompt.txt`, `package.json`, or this file.
- Prefer `apply_patch` over rewriting files.
- Use `npm test` as the verification command. A non-zero exit code is a test failure, not a completed task.
