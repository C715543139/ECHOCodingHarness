import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createEvalWorkspace,
  formatEvalSummary,
  jsonlHasContextProjection,
  removeEvalWorkspace,
  requestedToolNames,
  runOfflineEval,
  terminalToolEvents,
  textTurn,
  toolTurn,
} from './eval-harness.js';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => removeEvalWorkspace(workspace)));
});

describe('offline Fake Provider eval: loop-guards', () => {
  it('stops equivalent tool repetition before the threshold call and records a stable summary', async () => {
    const workspaceRoot = await createEvalWorkspace('echo-eval-repeat-');
    workspaces.push(workspaceRoot);
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'src', 'keep.txt'), 'ok\n', 'utf8');

    const run = await runOfflineEval({
      name: 'loop-guard-repeat',
      workspaceRoot,
      repeatedToolCallLimit: 2,
      goal: 'List the same directory until stopped.',
      responses: [
        toolTurn({ id: 'call-list-1', name: 'list_files', arguments: { path: 'src' } }),
        toolTurn({ id: 'call-list-2', name: 'list_files', arguments: { path: 'src' } }),
      ],
    });

    expect(run.summary).toBe(
      formatEvalSummary({
        name: 'loop-guard-repeat',
        status: 'limited',
        steps: 2,
        toolCalls: 2,
        stopReason: 'repeated_tool_call',
      }),
    );
    expect(run.record).toMatchObject({
      status: 'limited',
      steps: 2,
      toolCalls: 2,
      stopReason: 'repeated_tool_call',
    });
    expect(requestedToolNames(run.events)).toEqual(['list_files', 'list_files']);
    expect(run.events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
    expect(run.events.filter((event) => event.type === 'tool.denied')).toHaveLength(1);
    expect(run.events.some((event) => event.type === 'limit.reached')).toBe(true);
    expect(terminalToolEvents(run.events)).toHaveLength(2);
    expect(jsonlHasContextProjection(run.events)).toBe(true);
  });

  it('cancels before the first model step when the signal is already aborted', async () => {
    const workspaceRoot = await createEvalWorkspace('echo-eval-cancel-');
    workspaces.push(workspaceRoot);
    const controller = new AbortController();
    controller.abort();

    const run = await runOfflineEval({
      name: 'loop-guard-cancel',
      workspaceRoot,
      signal: controller.signal,
      responses: [textTurn('should not run')],
    });

    expect(run.summary).toBe(
      formatEvalSummary({
        name: 'loop-guard-cancel',
        status: 'cancelled',
        steps: 0,
        toolCalls: 0,
        stopReason: 'cancelled',
      }),
    );
    expect(run.provider.requests).toHaveLength(0);
    expect(run.events.map((event) => event.type)).toEqual([
      'session.started',
      'turn.started',
      'turn.cancelled',
    ]);
  });

  it('rejects a duplicate tool-call id before requesting or executing the tool', async () => {
    const workspaceRoot = await createEvalWorkspace('echo-eval-dup-');
    workspaces.push(workspaceRoot);

    const run = await runOfflineEval({
      name: 'loop-guard-duplicate-id',
      workspaceRoot,
      responses: [
        {
          events: [
            {
              type: 'tool_call',
              call: { id: 'duplicate', name: 'list_files', arguments: { path: 'src' } },
            },
            {
              type: 'tool_call',
              call: { id: 'duplicate', name: 'read_file', arguments: { path: 'src/keep.txt' } },
            },
            { type: 'completed', finishReason: 'tool_calls' },
          ],
        },
      ],
    });

    expect(run.summary).toBe(
      formatEvalSummary({
        name: 'loop-guard-duplicate-id',
        status: 'failed',
        steps: 1,
        toolCalls: 0,
        stopReason: 'provider_error',
      }),
    );
    expect(run.result.error).toMatchObject({
      category: 'provider_protocol',
      code: 'PROVIDER_DUPLICATE_TOOL_CALL_ID',
    });
    expect(run.events.filter((event) => event.type === 'tool.requested')).toHaveLength(0);
  });
});

describeWindows('offline Fake Provider eval: loop-guards timeout', () => {
  it('maps a command timeout to a failed tool result and then completes the turn', async () => {
    const workspaceRoot = await createEvalWorkspace('echo-eval-timeout-');
    workspaces.push(workspaceRoot);
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'src', 'keep.txt'), 'ok\n', 'utf8');

    const run = await runOfflineEval({
      name: 'loop-guard-timeout',
      workspaceRoot,
      timeoutMs: 8_000,
      responses: [
        toolTurn({
          id: 'call-wait',
          name: 'run_command',
          arguments: {
            command: 'Get-Content -LiteralPath src/keep.txt -Wait',
            timeoutMs: 200,
          },
        }),
        textTurn('stopped after the command timeout'),
      ],
    });

    expect(run.summary).toBe(
      formatEvalSummary({
        name: 'loop-guard-timeout',
        status: 'completed',
        steps: 2,
        toolCalls: 1,
        stopReason: 'completed',
      }),
    );
    expect(run.record.stopReason).toBe('completed');
    const failed = run.events.filter((event) => event.type === 'tool.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      payload: {
        result: {
          toolName: 'run_command',
          status: 'failed',
          metadata: { category: 'tool_timeout', code: 'COMMAND_TIMEOUT' },
        },
      },
    });
    expect(run.result.finalText).toContain('command timeout');
  });
});
