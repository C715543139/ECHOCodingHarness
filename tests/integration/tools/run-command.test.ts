import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../../../src/contracts/index.js';
import { runCommandTool } from '../../../src/tools/command/run-command.js';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const workspaces: string[] = [];

async function createContext(signal = new AbortController().signal): Promise<ToolContext> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'echo run command '));
  workspaces.push(workspaceRoot);
  return {
    limits: { maxOutputChars: 1_000, timeoutMs: 5_000 },
    sessionId: 'session-test',
    signal,
    stepId: 'step-test',
    toolCallId: 'call-test',
    turnId: 'turn-test',
    workspaceRoot,
  };
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, { force: true, recursive: true })),
  );
});

describeWindows('run_command tool', () => {
  it('returns successful structured facts for a zero exit', async () => {
    const result = await runCommandTool.execute(
      { command: "[Console]::Out.Write('ok')" },
      await createContext(),
    );

    expect(result).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ exitCode: 0, stderr: '', stdout: 'ok' }),
        status: 'completed',
        truncated: false,
      }),
    );
  });

  it('returns structured execution facts even when the command exits non-zero', async () => {
    const result = await runCommandTool.execute(
      { command: "[Console]::Error.Write('nope'); exit 9" },
      await createContext(),
    );

    expect(result).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ exitCode: 9, stderr: 'nope', stdout: '' }),
        status: 'completed',
        truncated: false,
      }),
    );
  });

  it('maps timeout to a stable tool error with bounded execution facts', async () => {
    const context = await createContext();
    const result = await runCommandTool.execute(
      { command: 'Start-Sleep -Seconds 30', timeoutMs: 100 },
      context,
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          category: 'tool_timeout',
          code: 'COMMAND_TIMEOUT',
          details: expect.objectContaining({ durationMs: expect.any(Number), exitCode: null }),
        }),
        status: 'failed',
      }),
    );
  });

  it('maps cancellation to the shared cancelled error category', async () => {
    const controller = new AbortController();
    const context = await createContext(controller.signal);
    controller.abort();

    const result = await runCommandTool.execute({ command: 'Write-Output never' }, context);

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ category: 'cancelled', code: 'COMMAND_CANCELLED' }),
        status: 'failed',
      }),
    );
  });

  it('rejects blank commands before spawning PowerShell', async () => {
    const result = await runCommandTool.execute({ command: '   ' }, await createContext());

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          category: 'invalid_tool_input',
          code: 'INVALID_COMMAND',
        }),
        status: 'failed',
      }),
    );
  });
});
