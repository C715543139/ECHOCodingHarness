import type { AgentResult, ApplicationService, SessionId, TurnId } from '../contracts/index.js';

export interface TurnStartWaiter {
  waitForTurnStarted(sessionId: SessionId, signal?: AbortSignal): Promise<TurnId>;
}

export interface ActiveTurnSnapshot {
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
}

export type SubmitTurnResult =
  | {
      readonly kind: 'accepted';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly acceptedAt: string;
      readonly promise: Promise<AgentResult>;
    }
  | {
      readonly kind: 'turn_active';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly activeSessionId: SessionId;
      readonly activeTurnId: TurnId;
    };

export type CancelTurnResult =
  | { readonly kind: 'cancelling'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly kind: 'not_active'; readonly sessionId: SessionId; readonly turnId: TurnId };

interface ActiveTurn {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly promise: Promise<AgentResult>;
}

export class ActiveTurnCoordinator {
  private readonly service: ApplicationService;
  private readonly waiter: TurnStartWaiter;
  private readonly now: () => string;
  private chain: Promise<void> = Promise.resolve();
  private active: ActiveTurn | undefined;

  constructor(input: {
    readonly service: ApplicationService;
    readonly waiter: TurnStartWaiter;
    readonly now?: () => string;
  }) {
    this.service = input.service;
    this.waiter = input.waiter;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  snapshot(): ActiveTurnSnapshot {
    if (this.active === undefined) return {};
    return { sessionId: this.active.sessionId, turnId: this.active.turnId };
  }

  async submitTurn(sessionId: SessionId, goal: string): Promise<SubmitTurnResult> {
    return this.serialize(async () => {
      if (this.active !== undefined) {
        return {
          kind: 'turn_active',
          sessionId,
          turnId: this.active.turnId,
          activeSessionId: this.active.sessionId,
          activeTurnId: this.active.turnId,
        };
      }

      const startWait = new AbortController();
      const started = this.waiter.waitForTurnStarted(sessionId, startWait.signal);
      const promise = this.service.runTurn({ sessionId, goal });
      promise.catch(() => undefined);
      try {
        const turnId = await Promise.race([started, promise.then((result) => result.turnId)]);
        startWait.abort();
        this.active = { sessionId, turnId, promise };
        void promise.finally(() => {
          if (this.active?.promise === promise) this.active = undefined;
        });
        return {
          kind: 'accepted',
          sessionId,
          turnId,
          acceptedAt: this.now(),
          promise,
        };
      } catch (error) {
        startWait.abort();
        this.active = undefined;
        throw error;
      }
    });
  }

  async cancelTurn(sessionId: SessionId, turnId: TurnId): Promise<CancelTurnResult> {
    const current = this.active;
    if (current === undefined || current.sessionId !== sessionId) {
      return { kind: 'not_active', sessionId, turnId };
    }
    if (current.turnId !== turnId) {
      return { kind: 'not_active', sessionId, turnId };
    }
    await this.service.cancelTurn(sessionId, turnId);
    return { kind: 'cancelling', sessionId, turnId };
  }

  async shutdown(timeoutMs: number): Promise<void> {
    const current = this.active;
    if (current === undefined) return;
    await this.service.cancelTurn(current.sessionId, current.turnId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current.promise.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
