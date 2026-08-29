import { describe, expect, it } from 'vitest';

// The acceptance script is a runtime ESM module outside the TS project.
// @ts-expect-error -- no project-owned declaration for scripts/*.mjs
import { analyzeDemoOutput } from '../../../scripts/demo-accept.mjs';

const storyStderr = `ECHO       | Fix the failing parser tests.

-- Step 1 ------------------------------------------------
TOOL       | search_text
QUERY      | "parseReport" in src
RESULT     | 1 match

-- Step 3 ------------------------------------------------
TOOL       | run_command
COMMAND    | npm test
RESULT     | FAIL | exit 1 | 2.4 s
           | 1 test failed

-- Step 4 ------------------------------------------------
TOOL       | apply_patch
TARGET     | src/parse-report.ts
RESULT     | OK | 1 file changed | +1 -1

-- Step 5 ------------------------------------------------
TOOL       | run_command
COMMAND    | npm test
RESULT     | OK | exit 0 | 2.1 s
           | 2 tests passed

-- Run completed -----------------------------------------
STEPS      | 5
TOOLS      | 5
CHANGES    | 1 file
VERIFIED   | npm test | exit 0 | 2.1 s
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
    const stats = analyzeDemoOutput(
      '',
      '-- Step 1 --\nFAIL       | provider_error\n\n-- Run failed --\nREASON     | provider_error\n',
      '',
    );
    expect(stats.stopReason).toBe('provider_error');
    expect(stats.done).toBe(false);
  });
});
