import type { EchoEvent, SessionId, TurnId } from '../contracts/index.js';

export type SessionEventListener = (event: EchoEvent) => void;

type StreamPipe =
  | { readonly kind: 'buffer'; readonly events: EchoEvent[] }
  | { readonly kind: 'live'; readonly listener: SessionEventListener };

interface InternalLease {
  readonly sessionId: SessionId;
  pipe: StreamPipe;
  unsubscribe: () => void;
  released: boolean;
  onRelease?: () => void;
}

function bySequence(left: EchoEvent, right: EchoEvent): number {
  return left.sequence - right.sequence;
}

export interface StreamLease {
  readonly sessionId: SessionId;
  readonly released: boolean;
  /**
   * Flush buffered events through `emit` first, then attach `emit` as the live
   * listener. Events that arrive while the buffer is being flushed are deferred
   * and emitted after the buffer, so live never overtakes backlog.
   */
  handover(emit: SessionEventListener): void;
  setOnRelease(handler: () => void): void;
  release(): void;
}

export interface SessionEventHub {
  publish(event: EchoEvent): void;
  subscribe(sessionId: SessionId, listener: SessionEventListener): () => void;
  waitForTurnStarted(sessionId: SessionId, signal?: AbortSignal): Promise<TurnId>;
  claimStream(sessionId: SessionId): StreamLease | undefined;
  currentStream(): StreamLease | undefined;
  releaseStream(lease?: StreamLease): void;
  closeStream(): void;
}

export function createSessionEventHub(): SessionEventHub {
  const listeners = new Map<SessionId, Set<SessionEventListener>>();
  let stream: InternalLease | undefined;
  let exposed: StreamLease | undefined;

  function subscribe(sessionId: SessionId, listener: SessionEventListener): () => void {
    const bucket = listeners.get(sessionId) ?? new Set<SessionEventListener>();
    bucket.add(listener);
    listeners.set(sessionId, bucket);
    return () => {
      const current = listeners.get(sessionId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) listeners.delete(sessionId);
    };
  }

  function makeLease(internal: InternalLease): StreamLease {
    const lease: StreamLease = {
      sessionId: internal.sessionId,
      get released() {
        return internal.released;
      },
      handover(emit) {
        if (internal.released || internal.pipe.kind === 'live') return;
        const queue = [...internal.pipe.events];
        const seen = new Set<number>();
        const collect: SessionEventListener = (event) => {
          queue.push(event);
        };
        internal.pipe = { kind: 'live', listener: collect };
        for (;;) {
          if (queue.length === 0) {
            internal.pipe = { kind: 'live', listener: emit };
            if (queue.length === 0) return;
            internal.pipe = { kind: 'live', listener: collect };
          }
          queue.sort(bySequence);
          const next = queue.shift();
          if (next === undefined || seen.has(next.sequence)) continue;
          seen.add(next.sequence);
          emit(next);
        }
      },
      setOnRelease(handler) {
        internal.onRelease = handler;
      },
      release() {
        if (internal.released) return;
        internal.released = true;
        internal.unsubscribe();
        if (stream === internal) {
          stream = undefined;
          exposed = undefined;
        }
        internal.onRelease?.();
      },
    };
    return lease;
  }

  return {
    publish(event) {
      const bucket = listeners.get(event.sessionId);
      if (bucket === undefined) return;
      for (const listener of bucket) listener(event);
    },
    subscribe,
    waitForTurnStarted(sessionId, signal) {
      return new Promise<TurnId>((resolve, reject) => {
        const finish = (action: () => void): void => {
          unsubscribe();
          signal?.removeEventListener('abort', onAbort);
          action();
        };
        const onAbort = (): void => {
          finish(() => {
            reject(signal?.reason ?? new Error('Waiting for the turn start was aborted.'));
          });
        };
        const unsubscribe = subscribe(sessionId, (event) => {
          if (event.type !== 'turn.started' || event.turnId === undefined) return;
          const turnId = event.turnId;
          finish(() => {
            resolve(turnId);
          });
        });
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    claimStream(sessionId) {
      if (stream !== undefined) return undefined;
      const internal: InternalLease = {
        sessionId,
        pipe: { kind: 'buffer', events: [] },
        unsubscribe: () => undefined,
        released: false,
      };
      internal.unsubscribe = subscribe(sessionId, (event) => {
        if (internal.released) return;
        if (internal.pipe.kind === 'buffer') {
          internal.pipe.events.push(event);
          return;
        }
        internal.pipe.listener(event);
      });
      stream = internal;
      exposed = makeLease(internal);
      return exposed;
    },
    currentStream() {
      return exposed;
    },
    releaseStream(lease) {
      if (lease !== undefined && lease !== exposed) return;
      exposed?.release();
    },
    closeStream() {
      exposed?.release();
    },
  };
}

export function formatSseEvent(input: {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}): string {
  const lines: string[] = [];
  if (input.id !== undefined) lines.push(`id: ${input.id}`);
  lines.push(`event: ${input.event}`);
  lines.push(`data: ${input.data}`);
  lines.push('', '');
  return lines.join('\n');
}
