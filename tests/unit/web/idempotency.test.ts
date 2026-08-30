import { describe, expect, it } from 'vitest';

import {
  createIdempotencyStore,
  fingerprintIdempotencyRequest,
  IDEMPOTENCY_CONFLICT_CODE,
  idempotencyKey,
  normalizeIdempotencyRoute,
} from '../../../src/web/idempotency.js';

const requestId = 'req_0123456789abcd';

describe('Web requestId idempotency', () => {
  it('scopes keys to method, normalized route, and requestId', () => {
    expect(normalizeIdempotencyRoute('/api/v1/sessions/')).toBe('/api/v1/sessions');
    expect(
      idempotencyKey({
        method: 'post',
        route: '/api/v1/sessions/',
        requestId,
      }),
    ).toBe(`POST /api/v1/sessions ${requestId}`);
  });

  it('replays the first accepted write and does not execute a second time', () => {
    const store = createIdempotencyStore<{ readonly status: number; readonly body: string }>();
    const fingerprint = fingerprintIdempotencyRequest({
      body: { text: 'hello' },
      routeParams: { sessionId: 'session-1' },
    });
    const first = store.begin(
      { method: 'POST', route: '/api/v1/sessions/:sessionId/turns', requestId },
      fingerprint,
    );
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') throw new Error('Expected first write to execute.');
    first.commit({ status: 202, body: 'accepted' });

    const replay = store.begin(
      { method: 'POST', route: '/api/v1/sessions/:sessionId/turns', requestId },
      fingerprint,
    );
    expect(replay).toEqual({ kind: 'replay', response: { status: 202, body: 'accepted' } });
  });

  it('merges in-flight duplicates onto the first accept or reject result', async () => {
    const store = createIdempotencyStore<string>();
    const fingerprint = fingerprintIdempotencyRequest({ body: {} });
    const first = store.begin(
      { method: 'POST', route: '/api/v1/sessions/s1/turns/t1/cancel', requestId },
      fingerprint,
    );
    const second = store.begin(
      { method: 'POST', route: '/api/v1/sessions/s1/turns/t1/cancel', requestId },
      fingerprint,
    );
    expect(first.kind).toBe('execute');
    expect(second.kind).toBe('inflight');
    if (first.kind !== 'execute' || second.kind !== 'inflight') {
      throw new Error('Expected in-flight merge.');
    }
    first.commit('cancelling');
    await expect(second.wait).resolves.toBe('cancelling');
  });

  it('returns IDEMPOTENCY_CONFLICT when the same key has a different fingerprint', () => {
    const store = createIdempotencyStore<string>();
    const first = store.begin(
      { method: 'PUT', route: '/api/v1/provider', requestId },
      fingerprintIdempotencyRequest({ body: { baseUrl: 'https://a.example' } }),
    );
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') throw new Error('Expected first config write.');
    first.commit('saved');

    const conflict = store.begin(
      { method: 'PUT', route: '/api/v1/provider', requestId },
      fingerprintIdempotencyRequest({ body: { baseUrl: 'https://b.example' } }),
    );
    expect(conflict).toEqual({ kind: 'conflict', code: IDEMPOTENCY_CONFLICT_CODE });
  });

  it('wakes concurrent waiters with the same terminal cancel response without sleeping', async () => {
    const store = createIdempotencyStore<{
      readonly data: { readonly state: 'cancelling' };
      readonly requestId: string;
    }>();
    const fingerprint = fingerprintIdempotencyRequest({ body: {} });
    const request = { method: 'POST', route: '/api/v1/sessions/s1/turns/t1/cancel', requestId };
    const first = store.begin(request, fingerprint);
    const second = store.begin(request, fingerprint);
    const third = store.begin(request, fingerprint);
    expect(first.kind).toBe('execute');
    expect(second.kind).toBe('inflight');
    expect(third.kind).toBe('inflight');
    if (first.kind !== 'execute' || second.kind !== 'inflight' || third.kind !== 'inflight') {
      throw new Error('Expected one executor and concurrent waiters.');
    }

    const terminal = { data: { state: 'cancelling' as const }, requestId };
    first.commit(terminal);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('idempotency waiter did not settle after terminal cancel'));
      }, 25);
    });
    try {
      await expect(Promise.race([Promise.all([second.wait, third.wait]), hung])).resolves.toEqual([
        terminal,
        terminal,
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    expect(store.begin(request, fingerprint)).toEqual({ kind: 'replay', response: terminal });
    expect(store.begin(request, fingerprintIdempotencyRequest({ body: { other: true } }))).toEqual({
      kind: 'conflict',
      code: IDEMPOTENCY_CONFLICT_CODE,
    });
  });

  it('keeps a pending record when a different fingerprint arrives before commit', () => {
    const store = createIdempotencyStore<string>();
    const first = store.begin(
      { method: 'POST', route: '/api/v1/sessions', requestId },
      fingerprintIdempotencyRequest({ body: { text: 'a' } }),
    );
    expect(first.kind).toBe('execute');
    const conflict = store.begin(
      { method: 'POST', route: '/api/v1/sessions', requestId },
      fingerprintIdempotencyRequest({ body: { text: 'b' } }),
    );
    expect(conflict).toEqual({ kind: 'conflict', code: IDEMPOTENCY_CONFLICT_CODE });
    if (first.kind !== 'execute') throw new Error('Expected first write to remain pending.');
    first.commit('created');
    expect(
      store.begin(
        { method: 'POST', route: '/api/v1/sessions', requestId },
        fingerprintIdempotencyRequest({ body: { text: 'a' } }),
      ),
    ).toEqual({ kind: 'replay', response: 'created' });
  });

  it('forgets records when a new store is created after restart', () => {
    const firstStore = createIdempotencyStore<string>();
    const fingerprint = fingerprintIdempotencyRequest({ body: { text: 'hello' } });
    const first = firstStore.begin(
      { method: 'POST', route: '/api/v1/sessions', requestId },
      fingerprint,
    );
    if (first.kind !== 'execute') throw new Error('Expected first create.');
    first.commit('created');

    const restarted = createIdempotencyStore<string>().begin(
      { method: 'POST', route: '/api/v1/sessions', requestId },
      fingerprint,
    );
    expect(restarted.kind).toBe('execute');
  });
});
