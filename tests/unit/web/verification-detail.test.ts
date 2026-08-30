import { describe, expect, it } from 'vitest';

import { projectTrace } from '../../../src/web/trace/index.js';

import { detailOf, fieldValue, recordOf } from './trace-detail-helpers.js';
import {
  eightTypeEvents,
  legacyPolicyEvents,
  resetTraceFixtureSequence,
  toolResult,
  traceEvent,
} from './trace-fixtures.js';

describe('Verification Inspector detail', () => {
  it('marks Verified only from a real run_command exit code 0', () => {
    const { records, details } = projectTrace(eightTypeEvents());
    const verification = recordOf(records, (item) => item.type === 'verification');
    const turn = recordOf(records, (item) => item.type === 'turn');
    const detail = detailOf(details, verification);
    expect(verification.status).toBe('Verified');
    expect(fieldValue(detail, '退出码')).toBe('0');
    expect(fieldValue(detail, '验证')).toBe('Verified');
    expect(fieldValue(detail, '含义')).toMatch(/仅表示命令退出码为 0/u);
    expect(fieldValue(detailOf(details, turn), '最近验证')).not.toBe('Not verified');
  });

  it('does not treat a non-zero exit or model text as Verified', () => {
    resetTraceFixtureSequence();
    const { records, details } = projectTrace([
      traceEvent('turn.started', { goal: 'prove tests' }),
      traceEvent('model.text', { text: 'All tests passed. Verified.' }),
      traceEvent('tool.requested', {
        call: { id: 'call-fail', name: 'run_command', arguments: { command: 'pnpm test' } },
        normalizedInput: { command: 'pnpm test' },
      }),
      traceEvent('tool.completed', {
        durationMs: 9,
        result: toolResult('completed', {
          toolCallId: 'call-fail',
          toolName: 'run_command',
          summary: 'Command exited with code 1 after 9 ms.',
          metadata: { exitCode: 1, durationMs: 9 },
        }),
      }),
      traceEvent('turn.completed', {
        result: {
          sessionId: 'session-trace',
          turnId: 'turn-1',
          status: 'completed',
          stopReason: 'completed',
          steps: 1,
          toolCalls: 1,
          finalText: 'Verified. Tests are green.',
        },
      }),
    ]);
    const verification = recordOf(records, (item) => item.type === 'verification');
    const detail = detailOf(details, verification);
    expect(verification.status).toBe('exit 1');
    expect(fieldValue(detail, '验证')).toBe('Not verified');
    expect(JSON.stringify(detail)).not.toMatch(/Tests are green/u);
  });

  it('shows Not verified when no run_command terminal exists', () => {
    const { records, details } = projectTrace(legacyPolicyEvents());
    expect(records.some((item) => item.type === 'verification')).toBe(false);
    const turn = recordOf(records, (item) => item.type === 'turn');
    expect(fieldValue(detailOf(details, turn), '最近验证')).toBe('Not verified');
  });

  it('does not invent verification by parsing command summaries', () => {
    resetTraceFixtureSequence();
    const { records } = projectTrace([
      traceEvent('turn.started', { goal: 'run' }),
      traceEvent('tool.requested', {
        call: { id: 'call-text', name: 'run_command', arguments: { command: 'echo hi' } },
        normalizedInput: { command: 'echo hi' },
      }),
      traceEvent('tool.completed', {
        durationMs: 2,
        result: toolResult('completed', {
          toolCallId: 'call-text',
          toolName: 'run_command',
          summary: 'exit 0 after 2 ms',
        }),
      }),
    ]);
    expect(records.some((item) => item.type === 'verification')).toBe(false);
  });
});
