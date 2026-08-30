import { describe, expect, it } from 'vitest';

import { projectTrace } from '../../../src/web/trace/index.js';

import {
  eightTypeEvents,
  resetTraceFixtureSequence,
  startedEvent,
  toolResult,
  traceEvent,
} from './trace-fixtures.js';

const FORBIDDEN = [
  /SECRET_REASONING_SHOULD_NOT_LEAK/u,
  /reasoning_details/iu,
  /model\.reasoning/u,
  /sk-[A-Za-z0-9]{8,}/u,
  /C:\\Users\\/iu,
  /\/home\/leak/u,
  /"jsonl"/u,
];

describe('Trace privacy', () => {
  it('does not emit chunk, retry, or reasoning records and drops sensitive fields', () => {
    resetTraceFixtureSequence();
    const events = [
      startedEvent(),
      traceEvent('turn.started', { goal: 'inspect' }),
      traceEvent('step.started', { step: 1 }),
      traceEvent('model.started', { provider: 'openai-compatible', model: 'echo-model' }),
      traceEvent('model.reasoning', {
        reasoning: 'SECRET_REASONING_SHOULD_NOT_LEAK',
        reasoningDetails: [{ type: 'text', text: 'hidden' }],
      }),
      traceEvent('model.text_delta', { delta: 'Hel' }),
      traceEvent('model.text_delta', { delta: 'lo' }),
      traceEvent('model.completed', { finishReason: 'stop' }),
      traceEvent('tool.requested', {
        call: {
          id: 'call-secret',
          name: 'read_file',
          arguments: {
            path: 'src/a.ts',
            apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
            reasoning_details: 'nope',
            jsonl: '{"type":"raw"}',
          },
        },
        normalizedInput: {
          path: 'src/a.ts',
          apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
          reasoning_details: 'nope',
        },
      }),
      traceEvent('tool.completed', {
        durationMs: 3,
        result: toolResult('completed', {
          toolCallId: 'call-secret',
          toolName: 'read_file',
          summary: 'read src/a.ts',
          content: 'file body',
          metadata: { path: 'C:\\Users\\leak\\repo\\src\\a.ts' },
        }),
      }),
    ];

    const projection = projectTrace(events);
    const serialized = JSON.stringify(projection);
    for (const pattern of FORBIDDEN) {
      expect(serialized).not.toMatch(pattern);
    }
    expect(projection.records.some((record) => record.type === 'agent')).toBe(true);
    expect(projection.records.filter((record) => record.type === 'agent')).toHaveLength(1);
    expect(projection.records.some((record) => record.id.includes('reasoning'))).toBe(false);
    expect(projection.records.some((record) => record.label.toLowerCase().includes('chunk'))).toBe(
      false,
    );
  });

  it('never copies raw session JSONL or provider payload keys into Inspector', () => {
    const { details } = projectTrace(eightTypeEvents());
    const serialized = JSON.stringify(details);
    expect(serialized).not.toMatch(/SECRET_REASONING/u);
    expect(serialized).not.toMatch(/reasoning_details/iu);
    expect(serialized).not.toMatch(/"type":"session\.started"/u);
  });
});
