import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runGoal } from '../../src/cli/run.js';
import { FakeProvider } from '../../src/provider/index.js';

const temporaryDirectories: string[] = [];
const demoRoot = fileURLToPath(new URL('../../fixtures/demo', import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function copyDemo(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-demo-story-'));
  temporaryDirectories.push(directory);
  await fs.cp(demoRoot, directory, { recursive: true });
  await fs.copyFile(
    path.join(directory, 'golden', 'parse-report.ts'),
    path.join(directory, 'src', 'parse-report.ts'),
  );
  await fs.copyFile(
    path.join(directory, 'golden', 'parse-report.test.ts'),
    path.join(directory, 'test', 'parse-report.test.ts'),
  );
  return directory;
}

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('CLI demo story', () => {
  it('renders inspect, failing tests, apply_patch, and a passing retest without leaking secrets', async () => {
    const root = await copyDemo();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'I will inspect the parser tests.' },
          {
            type: 'tool_call',
            call: {
              id: 'call-search',
              name: 'search_text',
              arguments: { query: 'parseReport', path: 'src' },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          {
            type: 'tool_call',
            call: {
              id: 'call-read',
              name: 'read_file',
              arguments: { path: 'src/parse-report.ts' },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          {
            type: 'tool_call',
            call: {
              id: 'call-test-1',
              name: 'run_command',
              arguments: { command: 'npm test' },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'The total ignores failed tests.' },
          {
            type: 'tool_call',
            call: {
              id: 'call-patch',
              name: 'apply_patch',
              arguments: {
                path: 'src/parse-report.ts',
                edits: [{ oldText: '    total: passed,', newText: '    total: passed + failed,' }],
              },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          {
            type: 'tool_call',
            call: {
              id: 'call-test-2',
              name: 'run_command',
              arguments: { command: 'npm test' },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'Parser totals now include failures and tests pass.' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const captured = output();

    const outcome = await runGoal(
      'Fix the failing parser tests without modifying tests.',
      { workspace: root, verbose: false, color: false, interactive: false },
      {
        env: { ECHO_API_KEY: 'test-key', ECHO_MODEL: 'fake-model' },
        io: captured.io,
        providerFactory: () => provider,
        userConfigDirectory: false,
      },
    );

    const stderr = captured.stderr();
    const stdout = captured.stdout();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({ status: 'completed', stopReason: 'completed' });
    expect(stdout).toContain('Parser totals now include failures and tests pass.');
    expect(stderr).toContain('-- Step 1 ');
    expect(stderr).toContain('ECHO       | I will inspect the parser tests.');
    expect(stderr).toContain('TOOL       | search_text');
    expect(stderr).toContain('PATH       | src/parse-report.ts');
    expect(stderr).toMatch(/FAIL \| exit 1/u);
    expect(stderr).toMatch(/1 test failed/u);
    expect(stderr).toContain('TOOL       | apply_patch');
    expect(stderr).toContain('TARGET     | src/parse-report.ts');
    expect(stderr).toContain('1 file changed');
    expect(stderr).toContain('total: passed + failed');
    expect(stderr).toMatch(/OK \| exit 0/u);
    expect(stderr).toContain('Run completed');
    expect(stderr).toContain('VERIFIED   | npm test | exit 0');
    expect(stderr).not.toContain('test-key');
    expect(stderr).not.toMatch(/[A-Za-z]:\\Users\\/u);
    expect(stdout).not.toMatch(/[A-Za-z]:\\Users\\/u);
    expect(`${stdout}\n${stderr}`).not.toMatch(/\breasoning\s*[:=]/iu);

    const patched = await fs.readFile(path.join(root, 'src', 'parse-report.ts'), 'utf8');
    expect(patched).toContain('total: passed + failed,');
    const tests = await fs.readFile(path.join(root, 'test', 'parse-report.test.ts'), 'utf8');
    expect(tests).toContain('parseReport counts failed tests in the total');
  }, 60_000);
});
