import { createHash } from 'node:crypto';

export const IDEMPOTENCY_CONFLICT_CODE = 'IDEMPOTENCY_CONFLICT' as const;

export interface IdempotencyRequest {
  readonly method: string;
  readonly route: string;
  readonly requestId: string;
}

export type IdempotencyBeginResult<T> =
  | {
      readonly kind: 'execute';
      readonly key: string;
      readonly requestId: string;
      readonly fingerprint: string;
      commit(response: T): void;
    }
  | { readonly kind: 'replay'; readonly response: T }
  | { readonly kind: 'inflight'; readonly wait: Promise<T> }
  | { readonly kind: 'conflict'; readonly code: typeof IDEMPOTENCY_CONFLICT_CODE };

interface PendingRecord<T> {
  readonly status: 'pending';
  readonly fingerprint: string;
  readonly waiters: ((response: T) => void)[];
}

interface CompletedRecord<T> {
  readonly status: 'completed';
  readonly fingerprint: string;
  readonly response: T;
}

type RecordState<T> = PendingRecord<T> | CompletedRecord<T>;

export function normalizeIdempotencyRoute(route: string): string {
  const trimmed = route.replace(/\/+$/u, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

export function idempotencyKey(input: IdempotencyRequest): string {
  return `${input.method.toUpperCase()} ${normalizeIdempotencyRoute(input.route)} ${input.requestId}`;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function fingerprintIdempotencyRequest(input: {
  readonly body: unknown;
  readonly routeParams?: Readonly<Record<string, string>>;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        body: input.body ?? null,
        routeParams: input.routeParams ?? {},
      }),
    )
    .digest('hex');
}

function settleWaiters<T>(waiters: readonly ((response: T) => void)[], response: T): void {
  for (const waiter of waiters) waiter(response);
}

export function createIdempotencyStore<T>(): {
  begin(request: IdempotencyRequest, fingerprint: string): IdempotencyBeginResult<T>;
} {
  const records = new Map<string, RecordState<T>>();

  return {
    begin(request, fingerprint) {
      const key = idempotencyKey(request);
      const current = records.get(key);
      if (current === undefined) {
        const pending: PendingRecord<T> = {
          status: 'pending',
          fingerprint,
          waiters: [],
        };
        records.set(key, pending);
        return {
          kind: 'execute',
          key,
          requestId: request.requestId,
          fingerprint,
          commit(response) {
            const latest = records.get(key);
            if (latest?.status !== 'pending') return;
            records.set(key, {
              status: 'completed',
              fingerprint: latest.fingerprint,
              response,
            });
            settleWaiters(latest.waiters, response);
          },
        };
      }
      if (current.fingerprint !== fingerprint) {
        return { kind: 'conflict', code: IDEMPOTENCY_CONFLICT_CODE };
      }
      if (current.status === 'completed') {
        return { kind: 'replay', response: current.response };
      }
      return {
        kind: 'inflight',
        wait: new Promise<T>((resolve) => {
          current.waiters.push(resolve);
        }),
      };
    },
  };
}
