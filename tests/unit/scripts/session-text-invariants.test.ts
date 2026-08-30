import { describe, expect, it } from 'vitest';

import {
  assertAggregatedSessionJsonl,
  assertAggregatedSessionText,
} from '../../../scripts/session-text-invariants.mjs';

function event(
  type: string,
  payload: Record<string, unknown>,
  extra: { id?: string; sequence?: number; stepId?: string; turnId?: string } = {},
) {
  return {
    id: extra.id ?? `event-${type}`,
    sequence: extra.sequence ?? 1,
    timestamp: '2026-08-30T00:00:00.000Z',
    sessionId: 'session-smoke',
    turnId: extra.turnId ?? 'turn-1',
    stepId: extra.stepId ?? 'step-1',
    type,
    payload,
  };
}

function jsonlLine(
  type: string,
  payload: Record<string, unknown>,
  extra: { id?: string; sequence?: number; stepId?: string } = {},
) {
  return JSON.stringify(event(type, payload, extra));
}

describe('assertAggregatedSessionText', () => {
  it('accepts one aggregated body per model response', () => {
    const body = 'x'.repeat(80);
    expect(
      assertAggregatedSessionText([
        event('model.started', { provider: 'fake', model: 'm' }, { sequence: 1 }),
        event('model.text', { text: body }, { id: 'event-text', sequence: 2 }),
        event('model.completed', { finishReason: 'stop' }, { sequence: 3 }),
      ]),
    ).toMatchObject({ modelResponses: 1, textEvents: 1, textChars: 80, textLineCount: 1 });
  });

  it('rejects persisted text_delta and mixed representations', () => {
    expect(() =>
      assertAggregatedSessionText([
        event('model.started', { provider: 'fake', model: 'm' }),
        event('model.text_delta', { delta: 'Hel' }),
        event('model.text_delta', { delta: 'lo' }, { id: 'event-d2', sequence: 3 }),
      ]),
    ).toThrow(/model\.text_delta/u);

    expect(() =>
      assertAggregatedSessionText([
        event('model.started', { provider: 'fake', model: 'm' }),
        event('model.text', { text: 'aggregated' }),
        event('model.text_delta', { delta: 'delta' }, { id: 'event-d', sequence: 3 }),
      ]),
    ).toThrow(/model\.text_delta/u);
  });

  it('rejects two model.text events in the same step', () => {
    expect(() =>
      assertAggregatedSessionText([
        event('model.started', { provider: 'fake', model: 'm' }),
        event('model.text', { text: 'one' }, { id: 'event-a', sequence: 2 }),
        event('model.text', { text: 'two' }, { id: 'event-b', sequence: 3 }),
      ]),
    ).toThrow(/2 model\.text events/u);
  });

  it('rejects an empty aggregated payload', () => {
    expect(() =>
      assertAggregatedSessionText([
        event('model.started', { provider: 'fake', model: 'm' }),
        event('model.text', { text: '' }),
      ]),
    ).toThrow(/empty or damaged/u);
  });

  it('allows one model.text on each of two steps', () => {
    expect(
      assertAggregatedSessionText([
        event('model.started', { provider: 'fake', model: 'm' }, { stepId: 'step-1', sequence: 1 }),
        event('model.text', { text: 'first' }, { stepId: 'step-1', id: 't1', sequence: 2 }),
        event('model.started', { provider: 'fake', model: 'm' }, { stepId: 'step-2', sequence: 3 }),
        event('model.text', { text: 'second' }, { stepId: 'step-2', id: 't2', sequence: 4 }),
      ]),
    ).toMatchObject({ modelResponses: 2, textEvents: 2, textChars: 11 });
  });

  it('accepts many short aggregated bodies across separate responses', () => {
    const events = [];
    for (let index = 1; index <= 8; index += 1) {
      const stepId = `step-${String(index)}`;
      events.push(
        event(
          'model.started',
          { provider: 'fake', model: 'm' },
          { stepId, id: `started-${String(index)}`, sequence: index * 2 - 1 },
        ),
        event(
          'model.text',
          { text: 'abcd' },
          { stepId, id: `text-${String(index)}`, sequence: index * 2 },
        ),
      );
    }
    expect(assertAggregatedSessionText(events)).toMatchObject({
      modelResponses: 8,
      textEvents: 8,
      textChars: 32,
    });
  });

  it('rejects a single response whose text envelopes grew with body length', () => {
    expect(() =>
      assertAggregatedSessionText([
        event('model.started', { provider: 'fake', model: 'm' }),
        event('model.text', { text: 'x'.repeat(20) }, { stepId: 'step-a', id: 't1', sequence: 2 }),
        event('model.text', { text: 'y'.repeat(20) }, { stepId: 'step-b', id: 't2', sequence: 3 }),
      ]),
    ).toThrow(/envelopes grew with body length/u);
  });
});

describe('assertAggregatedSessionJsonl', () => {
  it('accepts one serialized model.text line for a long body', () => {
    const body = 'x'.repeat(80);
    const jsonl = [
      jsonlLine('model.started', { provider: 'fake', model: 'm' }, { sequence: 1 }),
      jsonlLine('model.text', { text: body }, { id: 'event-text', sequence: 2 }),
      jsonlLine('model.completed', { finishReason: 'stop' }, { id: 'event-done', sequence: 3 }),
    ].join('\n');

    expect(assertAggregatedSessionJsonl(jsonl)).toMatchObject({
      modelResponses: 1,
      textEvents: 1,
      textChars: 80,
      textLineCount: 1,
    });
  });

  it('rejects JSONL that persisted per-chunk text envelopes', () => {
    const lines = [jsonlLine('model.started', { provider: 'fake', model: 'm' }, { sequence: 1 })];
    for (let index = 0; index < 40; index += 1) {
      lines.push(
        jsonlLine(
          'model.text_delta',
          { delta: 'ab' },
          { id: `event-d${String(index)}`, sequence: index + 2 },
        ),
      );
    }

    expect(() => assertAggregatedSessionJsonl(lines.join('\n'))).toThrow(/model\.text_delta/u);
  });

  it('rejects a JSONL whose total envelopes grew with a long body', () => {
    const body = 'x'.repeat(300);
    const lines = [
      jsonlLine('model.started', { provider: 'fake', model: 'm' }, { sequence: 1 }),
      jsonlLine('model.text', { text: body }, { id: 'event-text', sequence: 2 }),
    ];
    for (let index = 0; index < 200; index += 1) {
      lines.push(
        jsonlLine(
          'context.projected',
          { approximateTokens: 1, omittedEventCount: 0, truncationCount: 0 },
          { id: `event-pad-${String(index)}`, sequence: index + 3 },
        ),
      );
    }

    expect(() => assertAggregatedSessionJsonl(lines.join('\n'))).toThrow(
      /envelopes grew with body length/u,
    );
  });
});
