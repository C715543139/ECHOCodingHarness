import { describe, expect, it } from 'vitest';

import type { TraceRecordType } from '../../../src/contracts/web.js';
import { WEB_JSON_SCHEMAS, validateWebJsonSchema } from '../../../src/contracts/web-schema.js';
import { projectTrace, TRACE_TYPE_LABELS } from '../../../src/web/trace/index.js';

import { eightTypeEvents, resetTraceFixtureSequence, traceEvent } from './trace-fixtures.js';

const EIGHT_TYPES: readonly TraceRecordType[] = [
  'user',
  'context',
  'agent',
  'tool',
  'policy',
  'approval',
  'verification',
  'turn',
];

describe('Trace projector', () => {
  it('projects exactly the eight business record types in seq order', () => {
    const { records, details } = projectTrace(eightTypeEvents());
    const types = new Set(records.map((record) => record.type));

    expect([...types].sort()).toEqual([...EIGHT_TYPES].sort());
    expect(records.map((record) => record.seq)).toEqual(
      [...records].sort((left, right) => left.seq - right.seq).map((record) => record.seq),
    );
    for (const record of records) {
      expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.traceRecord, record)).toEqual([]);
      const detail = details[record.id];
      expect(detail).toBeDefined();
      expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.traceRecordDetail, detail)).toEqual([]);
      expect(detail?.id).toBe(record.id);
      expect(record.label).toBe(TRACE_TYPE_LABELS[record.type]);
    }
  });

  it('keeps one agent record when retries happen in the same step', () => {
    resetTraceFixtureSequence();
    const events = [
      traceEvent('turn.started', { goal: 'retry' }),
      traceEvent('step.started', { step: 1 }),
      traceEvent('model.started', { provider: 'openai-compatible', model: 'echo-model' }),
      traceEvent('model.failed', {
        error: {
          category: 'provider_network',
          code: 'PROVIDER_TIMEOUT',
          message: 'timeout',
          retryable: true,
        },
        attempt: 1,
      }),
      traceEvent('model.started', { provider: 'openai-compatible', model: 'echo-model' }),
      traceEvent('model.text', { text: 'recovered' }),
      traceEvent('model.completed', { finishReason: 'stop' }),
    ];
    const { records } = projectTrace(events);
    expect(records.filter((record) => record.type === 'agent')).toHaveLength(1);
    expect(records.find((record) => record.type === 'agent')?.status).toBe('completed');
  });
});
