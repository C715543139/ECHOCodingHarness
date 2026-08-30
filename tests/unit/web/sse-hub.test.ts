import { describe, expect, it } from 'vitest';

import type { EchoEvent, SessionId } from '../../../src/contracts/index.js';
import { createProviderIdentity } from '../../../src/session/index.js';
import { createSessionEventHub } from '../../../src/web/sse-hub.js';

const PROVIDER = createProviderIdentity('https://provider.example/v1');
const SESSION_ID = 'session-hub-1' as SessionId;

function event(sequence: number): EchoEvent {
  return {
    id: `event-${String(sequence)}`,
    sequence,
    timestamp: `2026-08-30T00:00:0${String(sequence)}.000Z`,
    sessionId: SESSION_ID,
    type: 'session.started',
    payload: {
      workspace: '.',
      safetyMode: 'balanced',
      eventSchemaVersion: 3,
      provider: PROVIDER,
      model: 'fake-model',
    },
  };
}

describe('SessionEventHub stream lease', () => {
  it('claims synchronously and rejects a second claim without awaiting', () => {
    const hub = createSessionEventHub();
    const first = hub.claimStream(SESSION_ID);
    const second = hub.claimStream('session-hub-2');
    expect(first).toBeDefined();
    expect(first).not.toBeInstanceOf(Promise);
    expect(second).toBeUndefined();
    if (first === undefined) throw new Error('expected lease');
    first.release();
    expect(hub.claimStream(SESSION_ID)).toBeDefined();
  });

  it('emits snapshot-buffer overlap once and never lets live overtake the buffer', () => {
    const hub = createSessionEventHub();
    const lease = hub.claimStream(SESSION_ID);
    expect(lease).toBeDefined();
    if (lease === undefined) throw new Error('expected lease');

    hub.publish(event(2));
    hub.publish(event(4));
    const sent: number[] = [];
    lease.handover((item) => {
      sent.push(item.sequence);
      if (item.sequence === 2) hub.publish(event(3));
    });
    hub.publish(event(5));
    expect(sent).toEqual([2, 3, 4, 5]);
    lease.release();
  });

  it('keeps events published during an awaited snapshot in the buffer', async () => {
    const hub = createSessionEventHub();
    const lease = hub.claimStream(SESSION_ID);
    expect(lease).toBeDefined();
    if (lease === undefined) throw new Error('expected lease');

    await Promise.resolve().then(() => {
      hub.publish(event(2));
    });
    const sent: number[] = [];
    lease.handover((item) => {
      sent.push(item.sequence);
    });
    expect(sent).toEqual([2]);
    lease.release();
  });

  it('keeps seq contiguous when snapshot drain and a gapped buffer receive the missing event', () => {
    const hub = createSessionEventHub();
    const lease = hub.claimStream(SESSION_ID);
    expect(lease).toBeDefined();
    if (lease === undefined) throw new Error('expected lease');

    hub.publish(event(2));
    hub.publish(event(4));
    const sent: number[] = [];
    const emit = (item: EchoEvent): void => {
      const last = sent.at(-1) ?? 0;
      if (item.sequence <= last) return;
      sent.push(item.sequence);
      if (item.sequence === 2) hub.publish(event(3));
    };
    emit(event(1));
    emit(event(2));
    lease.handover(emit);
    expect(sent).toEqual([1, 2, 3, 4]);
    lease.release();
  });

  it('emits a buffered sequence only once when snapshot and live overlap', () => {
    const hub = createSessionEventHub();
    const lease = hub.claimStream(SESSION_ID);
    expect(lease).toBeDefined();
    if (lease === undefined) throw new Error('expected lease');

    hub.publish(event(2));
    hub.publish(event(2));
    const sent: number[] = [];
    lease.handover((item) => {
      sent.push(item.sequence);
    });
    expect(sent).toEqual([2]);
    lease.release();
  });
});
