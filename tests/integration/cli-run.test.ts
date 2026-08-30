import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InteractiveApprovalHandler, runGoal, toExitCode } from '../../src/cli/run.js';
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
    expect(captured.stderr()).toContain('ECHO       | do the task');
    expect(captured.stderr()).toContain('Run completed');
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
      payload: { eventSchemaVersion: 3 },
    });
    expect(provider.listModelCallCount).toBe(0);
  });

  it('lets CLI --model override the config model without querying /models', async () => {
    const root = await workspace();
    await writeArtifactConfig(root, 'config-model');
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'cli model' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const captured = output();

    const outcome = await runGoal(
      'do the task',
      {
        workspace: root,
        model: 'cli-model',
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
      },
    );

    expect(outcome.exitCode).toBe(0);
    expect(provider.requests[0]?.model).toBe('cli-model');
    expect(provider.listModelCallCount).toBe(0);
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

  it('shows approval choices on stderr before accepting an interactive run decision', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          {
            type: 'tool_call',
            call: {
              id: 'call-version',
              name: 'run_command',
              arguments: { command: 'node --version' },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'version checked' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const captured = output();
    const approvalInput = new PassThrough();
    let approvalStderr = '';
    const approvalOutput = new Writable({
      write(chunk, _encoding, callback) {
        approvalStderr += String(chunk);
        callback();
      },
    });
    const approvalHandler = new InteractiveApprovalHandler(approvalInput, approvalOutput);

    const running = runGoal(
      'check the version',
      { workspace: root, verbose: false, color: false, interactive: true, artifactRoot: root },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
        approvalHandler,
      },
    );
    await vi.waitFor(() => expect(approvalStderr).toContain('Approve [y] once'));
    approvalInput.end('y\n');
    const outcome = await running;

    expect(outcome.exitCode).toBe(0);
    expect(approvalStderr).toContain('Approve [y] once / [s] session / [n] deny');
    expect(captured.stdout()).toBe('version checked\n');
    expect(captured.stdout()).not.toContain('Approve [y] once');
  });

  it('fails reasoning-only length instead of printing a blank completed run', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          { type: 'reasoning_delta', delta: { reasoning: 'hidden' } },
          { type: 'completed', finishReason: 'length' },
        ],
      },
    ]);
    const captured = output();
    const outcome = await runGoal(
      'analyze',
      { workspace: root, verbose: false, color: false, interactive: false, artifactRoot: root },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
      },
    );
    expect(outcome.exitCode).toBe(3);
    expect(captured.stdout()).toBe('');
    expect(captured.stderr()).toContain('Run failed');
    expect(captured.stderr()).toContain('provider_error');
    expect(captured.stderr()).not.toContain('hidden');
  });

  it('keeps partial stdout when the model hits the output limit', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'partial body' },
          { type: 'completed', finishReason: 'length' },
        ],
      },
    ]);
    const captured = output();
    const outcome = await runGoal(
      'write',
      { workspace: root, verbose: false, color: false, interactive: false, artifactRoot: root },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
      },
    );
    expect(outcome.exitCode).toBe(6);
    expect(captured.stdout()).toBe('partial body\n');
    expect(captured.stderr()).toContain('Run limited');
    expect(captured.stderr()).toContain('output_limit');
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
    expect(toExitCode({ ...base, status: 'limited', stopReason: 'output_limit' })).toBe(6);
    expect(toExitCode({ ...base, status: 'cancelled', stopReason: 'cancelled' })).toBe(130);
    expect(toExitCode({ ...base, status: 'failed', stopReason: 'provider_error' })).toBe(3);
    expect(toExitCode({ ...base, status: 'failed', stopReason: 'tool_error' })).toBe(4);
    expect(toExitCode({ ...base, status: 'failed', stopReason: 'policy_denied' })).toBe(5);
  });

  it('does not import or invoke model catalog discovery', async () => {
    const runSource = await fs.readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/cli/run.ts'),
      'utf8',
    );
    expect(runSource).not.toContain('ProcessModelCatalog');
    expect(runSource).not.toContain('listCandidates');
    expect(runSource).not.toContain('listModelIds');
    const chatSource = await fs.readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/cli/chat.ts'),
      'utf8',
    );
    expect(chatSource).toContain('ProcessModelCatalog');
    expect(chatSource).toContain('listCandidates');
  });
});
