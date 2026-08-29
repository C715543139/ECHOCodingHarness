import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGoal, toExitCode } from '../../src/cli/run.js';
import type { AgentResult } from '../../src/contracts/index.js';
import { FakeProvider } from '../../src/provider/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-cli-run-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeArtifactConfig(artifactRoot: string, model = 'fake-model'): Promise<void> {
  await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(artifactRoot, 'config', 'echo.config.json'),
    JSON.stringify({
      baseUrl: 'https://provider.example/v1',
      model,
      modelCatalog: { source: 'discover' },
      safetyMode: 'balanced',
    }),
    'utf8',
  );
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

describe('CLI run integration', () => {
  it('runs a deterministic Provider turn, separates output channels, and persists JSONL', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'task complete' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const captured = output();

    const outcome = await runGoal(
      'do the task',
      { workspace: root, verbose: false, color: false, interactive: false, artifactRoot: root },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
      },
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({ status: 'completed', finalText: 'task complete' });
    expect(captured.stdout()).toBe('task complete\n');
    expect(captured.stderr()).toContain('ECHO   do the task');
    expect(captured.stderr()).toContain('DONE   completed');
    const files = await fs.readdir(path.join(root, '.echo', 'sessions'));
    expect(files).toHaveLength(1);
    const log = await fs.readFile(path.join(root, '.echo', 'sessions', files[0] as string), 'utf8');
    expect(log).not.toContain('test-key');
    expect(log).not.toContain('https://');
    const parsed = log
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { type: string; payload?: { eventSchemaVersion?: number } },
      );
    expect(parsed.at(-1)?.type).toBe('turn.completed');
    expect(parsed[0]).toMatchObject({
      type: 'session.started',
      payload: { eventSchemaVersion: 2 },
    });
  });

  it('fails configuration before constructing a Provider and never prints a secret', async () => {
    const root = await workspace();
    const captured = output();
    const providerFactory = vi.fn();

    const outcome = await runGoal(
      'do the task',
      { workspace: root, verbose: false, color: false, interactive: false, artifactRoot: root },
      {
        env: { ECHO_API_KEY: 'top-secret-value' },
        io: captured.io,
        providerFactory,
      },
    );

    expect(outcome).toEqual({ exitCode: 2 });
    expect(providerFactory).not.toHaveBeenCalled();
    expect(captured.stderr()).toContain('echo-harness config');
    expect(captured.stderr()).not.toContain('top-secret-value');
    await expect(fs.stat(path.join(root, 'config', 'echo.config.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('denies approval-required operations without waiting in non-interactive mode', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          {
            type: 'tool_call',
            call: {
              id: 'call-install',
              name: 'run_command',
              arguments: { command: 'pnpm install' },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    const captured = output();

    const outcome = await runGoal(
      'install dependencies',
      { workspace: root, verbose: false, color: false, interactive: false, artifactRoot: root },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
      },
    );

    expect(outcome.exitCode).toBe(5);
    expect(outcome.result).toMatchObject({ status: 'failed', stopReason: 'policy_denied' });
    expect(captured.stderr()).toContain('APPROVAL');
    expect(captured.stderr()).toContain('DENIED');
  });

  it('maps every Agent result class to the stable documented exit code', () => {
    const base: AgentResult = {
      sessionId: 'session',
      turnId: 'turn',
      status: 'completed',
      stopReason: 'completed',
      steps: 1,
      toolCalls: 0,
    };
    expect(toExitCode(base)).toBe(0);
    expect(toExitCode({ ...base, status: 'limited', stopReason: 'max_steps' })).toBe(6);
    expect(toExitCode({ ...base, status: 'cancelled', stopReason: 'cancelled' })).toBe(130);
    expect(toExitCode({ ...base, status: 'failed', stopReason: 'provider_error' })).toBe(3);
    expect(toExitCode({ ...base, status: 'failed', stopReason: 'tool_error' })).toBe(4);
    expect(toExitCode({ ...base, status: 'failed', stopReason: 'policy_denied' })).toBe(5);
  });
});
