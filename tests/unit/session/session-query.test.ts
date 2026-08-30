import { describe, expect, it } from 'vitest';

import type { EchoEvent, EchoEventOf, EchoEventType } from '../../../src/contracts/index.js';
import { EVENT_SCHEMA_VERSION } from '../../../src/contracts/index.js';
import { createProviderIdentity } from '../../../src/session/index.js';
import { assertRecoverableEvents } from '../../../src/session/session-query.js';

const provider = createProviderIdentity('https://provider.example/v1');

function event<TType extends EchoEventType>(
  type: TType,
  payload: EchoEventOf<TType>['payload'],
  extra: Partial<Pick<EchoEvent, 'id' | 'sequence' | 'turnId' | 'stepId'>> = {},
): EchoEventOf<TType> {
  return {
    id: extra.id ?? `event-${type}`,
    sequence: extra.sequence ?? 1,
    timestamp: '2026-08-29T00:00:00.000Z',
    sessionId: 'session-query',
    turnId: extra.turnId ?? 'turn-1',
    stepId: extra.stepId ?? 'step-1',
    type,
    payload,
  };
}

function started(sequence = 1): EchoEvent {
  return {
    id: 'event-started',
    sequence,
    timestamp: '2026-08-29T00:00:00.000Z',
    sessionId: 'session-query',
    type: 'session.started',
    payload: {
      workspace: '.',
      safetyMode: 'balanced',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      provider,
      model: 'fake-model',
    },
  };
}

describe('assertRecoverableEvents', () => {
  it('accepts aggregated model.text and legacy model.text_delta in separate sessions', () => {
    expect(() =>
      assertRecoverableEvents([
        started(),
        event('model.text', { text: 'Hello' }, { id: 'event-text', sequence: 2 }),
      ]),
    ).not.toThrow();
    expect(() =>
      assertRecoverableEvents([
        started(),
        event('model.text_delta', { delta: 'Hel' }, { id: 'event-d1', sequence: 2 }),
        event('model.text_delta', { delta: 'lo' }, { id: 'event-d2', sequence: 3 }),
      ]),
    ).not.toThrow();
  });

  it('rejects mixed aggregated and incremental text in the same step', () => {
    expect(() =>
      assertRecoverableEvents([
        started(),
        event('model.text', { text: 'aggregated' }, { id: 'event-text', sequence: 2 }),
        event('model.text_delta', { delta: 'delta' }, { id: 'event-delta', sequence: 3 }),
      ]),
    ).toThrow(
      expect.objectContaining({
        category: 'storage',
        code: 'SESSION_LOG_INVALID',
      }),
    );
  });

  it('allows different steps to use different text representations', () => {
    expect(() =>
      assertRecoverableEvents([
        started(),
        event('model.text', { text: 'new' }, { id: 'event-text', sequence: 2, stepId: 'step-1' }),
        event(
          'model.text_delta',
          { delta: 'old' },
          { id: 'event-delta', sequence: 3, stepId: 'step-2' },
        ),
      ]),
    ).not.toThrow();
  });

  it('rejects a damaged aggregated text payload', () => {
    expect(() =>
      assertRecoverableEvents([
        started(),
        {
          id: 'event-bad',
          sequence: 2,
          timestamp: '2026-08-29T00:00:00.000Z',
          sessionId: 'session-query',
          turnId: 'turn-1',
          stepId: 'step-1',
          type: 'model.text',
          payload: { text: '', partial: true },
        } as EchoEvent,
      ]),
    ).toThrow(
      expect.objectContaining({
        category: 'storage',
        code: 'SESSION_LOG_INVALID',
      }),
    );
  });
});
