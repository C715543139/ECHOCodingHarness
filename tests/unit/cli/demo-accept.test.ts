import { describe, expect, it } from 'vitest';

// The acceptance script is a runtime ESM module outside the TS project.
// @ts-expect-error -- no project-owned declaration for scripts/*.mjs
import { analyzeDemoOutput } from '../../../scripts/demo-accept.mjs';

const storyStderr = `ECHO   Fix the failing parser tests.
STEP   1
TOOL   search_text   "parseReport" in src
OK     1 match
STEP   3
TOOL   run_command   npm test
FAIL   exit 1 · 2.4s
  1 test failed
STEP   4
TOOL   apply_patch   src/parse-report.ts
OK     src/parse-report.ts · +1 -1
STEP   5
TOOL   run_command   npm test
OK     exit 0 · 2.1s
  2 tests passed
DONE   completed
  5 steps · 5 tool calls · 1 file changed
  Verification: npm test · exit 0
`;

describe('demo acceptance stats', () => {
  it('reads stopReason from the Turn summary, not an earlier failed test command', () => {
    const stats = analyzeDemoOutput('tests pass\n', storyStderr, 'secret-key');
    expect(stats.stopReason).toBe('completed');
    expect(stats.failedTest).toBe(true);
    expect(stats.applyPatch).toBe(true);
    expect(stats.passingRetest).toBe(true);
    expect(stats.done).toBe(true);
    expect(stats.story).toBe(true);
    expect(stats.leak).toBe(false);
  });

  it('keeps a terminal provider failure as the stopReason', () => {
    const stats = analyzeDemoOutput('', 'STEP   1\nFAIL   provider_error\n', '');
    expect(stats.stopReason).toBe('provider_error');
    expect(stats.done).toBe(false);
  });
});
