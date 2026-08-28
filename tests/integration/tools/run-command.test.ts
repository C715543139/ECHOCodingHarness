import { access, mkdtemp, rm } from 'node:fs/promises';
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

  it.each([
    ['null', null],
    ['an array', []],
    ['a missing command', {}],
    ['a non-string command', { command: 7 }],
    ['a command containing NUL', { command: 'Write\0Output never' }],
    ['a zero timeout', { command: 'Write-Output never', timeoutMs: 0 }],
    ['a fractional timeout', { command: 'Write-Output never', timeoutMs: 1.5 }],
    [
      'an unsafe integer timeout',
      { command: 'Write-Output never', timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ['an explicitly undefined timeout', { command: 'Write-Output never', timeoutMs: undefined }],
  ])('returns invalid_tool_input without throwing for %s', async (_label, input) => {
    const result = await runCommandTool.execute(input as never, await createContext());

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

  it('rejects unexpected properties without starting a process', async () => {
    const context = await createContext();
    const marker = join(context.workspaceRoot, 'should-not-exist.txt');
    const result = await runCommandTool.execute(
      {
        command: "Set-Content -LiteralPath 'should-not-exist.txt' -Value unexpected",
        unexpected: true,
      } as never,
      context,
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ category: 'invalid_tool_input' }),
        status: 'failed',
      }),
    );
    await expect(access(marker)).rejects.toThrow();
  });

  it('keeps the runtime input rules aligned with the declared JSON Schema', () => {
    expect(runCommandTool.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        command: {
          minLength: 1,
          pattern: '^(?=[\\s\\S]*\\S)[^\\u0000]*$',
          type: 'string',
        },
        timeoutMs: {
          maximum: Number.MAX_SAFE_INTEGER,
          minimum: 1,
          type: 'integer',
        },
      },
      required: ['command'],
      type: 'object',
    });
  });
});
