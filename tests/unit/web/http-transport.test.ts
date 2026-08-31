// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BootstrapDto,
  ProviderConfigDto,
  RuntimeCapabilitiesDto,
  SessionRuntimeDto,
  SessionSummaryDto,
  SessionViewDto,
  TraceRecordDto,
} from '../../../src/contracts/web.js';
import { createHttpTransport } from '../../../src/web/client/transport/http-transport.js';

const capabilities: RuntimeCapabilitiesDto = {
  canCreateSession: true,
  canSubmitTurn: true,
  canChangeRuntime: true,
  canCancelTurn: false,
  canRespondToApproval: false,
};
const provider: ProviderConfigDto = {
  baseUrl: 'https://provider.example/v1',
  catalog: { source: 'discover', cachedModels: ['model-a'] },
  defaultModel: 'model-a',
  apiKeyConfigured: true,
  writable: true,
};
const summary: SessionSummaryDto = {
  id: 'session-1',
  shortId: 'sess01',
  title: 'Session one',
  updatedAt: '2026-08-30T10:00:00.000Z',
  turnCount: 0,
  phase: 'idle',
  model: 'model-a',
  safetyMode: 'balanced',
};
const runtime: SessionRuntimeDto = {
  ...summary,
  context: { usedApproxTokens: 10, limitApproxTokens: 256_000 },
};
const sessionView: SessionViewDto = { session: runtime, capabilities };
const bootstrap: BootstrapDto = {
  workspace: { name: 'fixture', fingerprint: 'fixture-fingerprint' },
  provider,
  capabilities,
  suggestedSessionId: summary.id,
};
const trace: TraceRecordDto = {
  id: 'user_turn-1',
  seq: 1,
  turnId: 'turn-1',
  time: '2026-08-30T10:01:00.000Z',
  type: 'user',
  label: '用户',
  status: 'completed',
  hasDetails: true,
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HTTP Web console transport', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.history.replaceState(null, '', '/#bootstrap=bootstrap-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bootstraps, loads projections, executes commands, and applies SSE deltas', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (url === '/api/v1/auth/bootstrap') return new Response(null, { status: 204 });
        if (url === '/api/v1/bootstrap')
          return json({ data: bootstrap, requestId: 'request-bootstrap-1' });
        if (url === '/api/v1/sessions?limit=30') {
          return json({
            data: { items: [summary], nextCursor: 'session-1' },
            requestId: 'request-sessions-1',
          });
        }
        if (url === '/api/v1/sessions?limit=30&cursor=session-1') {
          return json({ data: { items: [] }, requestId: 'request-sessions-2' });
        }
        if (url === '/api/v1/sessions/session-1') {
          return json({ data: sessionView, requestId: 'request-session-1' });
        }
        if (url.includes('/chat?')) {
          return json({
            data: { items: [] },
            requestId: 'request-chat-1',
          });
        }
        if (url.includes('/trace?')) {
          return json({
            data: { items: [trace] },
            requestId: 'request-trace-1',
          });
        }
        if (url === '/api/v1/sessions/session-1/trace/user_turn-1') {
          return json({
            data: { ...trace, sections: [], relatedRecordIds: [] },
            requestId: 'request-trace-detail-1',
          });
        }
        if (url === '/api/v1/sessions/session-1/trace/missing') {
          return json(
            {
              error: {
                code: 'NOT_FOUND',
                message: 'The trace record was not found.',
                retryable: false,
              },
              requestId: 'request-trace-missing',
            },
            404,
          );
        }
        if (url === '/api/v1/provider' && method === 'GET') {
          return json({ data: provider, requestId: 'request-provider-1' });
        }
        if (url === '/api/v1/provider' && method === 'PUT') {
          return json({ data: provider, requestId: 'request-provider-2' });
        }
        if (url === '/api/v1/provider/discover') {
          return json({
            data: { models: ['model-a', 'model-b'], fetchedAt: '2026-08-30T11:00:00.000Z' },
            requestId: 'request-discover-1',
          });
        }
        if (url === '/api/v1/sessions' && method === 'POST') {
          return json({ data: sessionView, requestId: 'request-create-1' }, 201);
        }
        if (url.endsWith('/turns')) {
          return json(
            {
              data: {
                sessionId: summary.id,
                turnId: 'turn-accepted',
                acceptedAt: '2026-08-30T10:01:00.000Z',
              },
              requestId: 'request-turn-1',
            },
            202,
          );
        }
        if (url.endsWith('/runtime')) {
          return json({ data: sessionView, requestId: 'request-command-1' }, 202);
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    const transport = createHttpTransport();
    await transport.start();

    expect(location.hash).toBe('');
    expect(transport.getSnapshot()).toMatchObject({
      connection: 'reconnecting',
      selectedSessionId: 'session-1',
      loadingHistory: false,
    });
    const stream = FakeEventSource.instances.at(-1);
    expect(stream?.url).toContain('/events?after=1');
    stream?.onopen?.();
    expect(transport.getSnapshot().connection).toBe('connected');

    stream?.emit('record.upsert', {
      type: 'record.upsert',
      sessionId: 'session-1',
      seq: 2,
      delta: {
        view: sessionView,
        traceRecords: [{ ...trace, id: 'turn_turn-1', seq: 2, type: 'turn' }],
      },
    });
    expect(transport.getSnapshot().traceRecords.map((item) => item.seq)).toEqual([1, 2]);

    transport.selectTraceRecord(trace.id);
    await vi.waitFor(() => {
      expect(transport.getSnapshot().inspectorDetail?.id).toBe(trace.id);
    });
    transport.openSettings();
    await vi.waitFor(() => {
      expect(transport.getSnapshot().settingsOpen).toBe(true);
    });
    transport.discoverModels();
    await vi.waitFor(() => {
      expect(transport.getSnapshot().lastDiscoveredAt).toBeDefined();
    });
    transport.saveProviderDraft();
    await vi.waitFor(() => {
      expect(transport.getSnapshot().settingsOpen).toBe(false);
    });
    transport.loadMoreSessions();
    await vi.waitFor(() => {
      expect(transport.getSnapshot().hasMoreSessions).toBe(false);
    });
    transport.setComposerText('hello');
    const streamCountBeforeSubmit = FakeEventSource.instances.length;
    transport.submitTurn();
    await vi.waitFor(() => {
      expect(calls.some((call) => call === 'POST /api/v1/sessions/session-1/turns')).toBe(true);
      expect(transport.getSnapshot().composerText).toBe('');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeEventSource.instances).toHaveLength(streamCountBeforeSubmit);
    expect(stream?.closed).toBe(false);
    expect(transport.getSnapshot().connection).toBe('connected');
    transport.selectTraceRecord('missing');
    await vi.waitFor(() => {
      expect(transport.getSnapshot().lastCommandError).toMatchObject({ code: 'NOT_FOUND' });
    });
    expect(transport.getSnapshot().connection).toBe('connected');
    transport.changeRuntime({ safetyMode: 'safe' });
    await vi.waitFor(() => {
      expect(calls.some((call) => call === 'PATCH /api/v1/sessions/session-1/runtime')).toBe(true);
    });
    transport.createSession();
    await vi.waitFor(() => {
      expect(calls.filter((call) => call === 'POST /api/v1/sessions').length).toBe(1);
    });
    transport.dispose();
    expect(FakeEventSource.instances.at(-1)?.closed).toBe(true);
  });

  it('preserves content and requests an explicit resync after a stream gap', async () => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/bootstrap')
          return json({ data: bootstrap, requestId: 'request-bootstrap-2' });
        if (url === '/api/v1/sessions?limit=30') {
          return json({ data: { items: [summary] }, requestId: 'request-sessions-3' });
        }
        if (url === '/api/v1/sessions/session-1') {
          return json({ data: sessionView, requestId: 'request-session-2' });
        }
        if (url.includes('/chat?')) {
          return json({ data: { items: [] }, requestId: 'request-chat-2' });
        }
        if (url.includes('/trace?')) {
          return json({ data: { items: [trace] }, requestId: 'request-trace-2' });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const transport = createHttpTransport();
    await transport.start();
    FakeEventSource.instances.at(-1)?.emit('resync.required', {
      type: 'resync.required',
      sessionId: 'session-1',
      lastAvailableSeq: 4,
      reason: 'history_gap',
    });
    expect(transport.getSnapshot()).toMatchObject({
      connection: 'reconnecting',
      resyncRequired: true,
      traceRecords: [trace],
    });
  });

  it('clears global active-turn capabilities when another Session reaches its terminal event', async () => {
    window.history.replaceState(null, '', '/');
    const activeSummary: SessionSummaryDto = {
      ...summary,
      id: 'session-active',
      shortId: 'active1',
      title: 'Active Session',
      phase: 'running',
    };
    const selectedSummary: SessionSummaryDto = {
      ...summary,
      id: 'session-selected',
      shortId: 'select1',
      title: 'Selected Session',
    };
    const activeCapabilities: RuntimeCapabilitiesDto = {
      canCreateSession: true,
      canSubmitTurn: false,
      canChangeRuntime: false,
      canCancelTurn: false,
      canRespondToApproval: false,
      submitTurnBlockedReason: 'turn_active',
      changeRuntimeBlockedReason: 'turn_active',
      activeSessionId: activeSummary.id,
      activeTurnId: 'turn-active',
    };
    const selectedRuntime: SessionRuntimeDto = {
      ...selectedSummary,
      context: { usedApproxTokens: 0, limitApproxTokens: 256_000 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/bootstrap') {
          return json({
            data: {
              ...bootstrap,
              capabilities: activeCapabilities,
              suggestedSessionId: selectedSummary.id,
            },
            requestId: 'request-bootstrap-terminal',
          });
        }
        if (url === '/api/v1/sessions?limit=30') {
          return json({
            data: { items: [activeSummary, selectedSummary] },
            requestId: 'request-sessions-terminal',
          });
        }
        if (url === `/api/v1/sessions/${selectedSummary.id}`) {
          return json({
            data: { session: selectedRuntime, capabilities: activeCapabilities },
            requestId: 'request-selected-terminal',
          });
        }
        if (url.includes('/chat?') || url.includes('/trace?')) {
          return json({ data: { items: [] }, requestId: 'request-page-terminal' });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const transport = createHttpTransport();
    await transport.start();
    const stream = FakeEventSource.instances.at(-1);
    expect(stream?.url).toContain(`/sessions/${activeSummary.id}/events`);
    expect(transport.getSnapshot().selectedSessionId).toBe(selectedSummary.id);
    expect(transport.getSnapshot().bootstrap.capabilities.activeSessionId).toBe(activeSummary.id);

    stream?.emit('turn.terminal', {
      type: 'turn.terminal',
      sessionId: activeSummary.id,
      seq: 9,
      turnId: 'turn-active',
      status: 'completed',
      delta: {
        view: {
          session: { ...activeSummary, phase: 'completed', context: selectedRuntime.context },
          capabilities,
        },
      },
    });

    expect(transport.getSnapshot().selectedRuntime?.id).toBe(selectedSummary.id);
    expect(transport.getSnapshot().bootstrap.capabilities).toEqual(capabilities);
    transport.dispose();
  });

  it('deletes the selected session and clears its local projections', async () => {
    window.history.replaceState(null, '', '/');
    const calls: { readonly url: string; readonly init?: RequestInit }[] = [];
    let deleted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, ...(init === undefined ? {} : { init }) });
        if (url === '/api/v1/bootstrap') {
          return json({ data: bootstrap, requestId: 'request-bootstrap-delete' });
        }
        if (url === '/api/v1/sessions?limit=30') {
          return json({
            data: { items: deleted ? [] : [summary] },
            requestId: 'request-list-delete',
          });
        }
        if (url === `/api/v1/sessions/${summary.id}` && init?.method === 'DELETE') {
          deleted = true;
          return json({
            data: { sessionId: summary.id, stoppedActiveTurn: false },
            requestId: 'request-delete-session',
          });
        }
        if (url === `/api/v1/sessions/${summary.id}`) {
          return json({ data: sessionView, requestId: 'request-view-delete' });
        }
        if (url.includes('/chat?') || url.includes('/trace?')) {
          return json({ data: { items: [] }, requestId: 'request-page-delete' });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const transport = createHttpTransport();
    await transport.start();
    await transport.deleteSession(summary.id);

    expect(transport.getSnapshot()).toMatchObject({
      connection: 'connected',
      sessions: [],
      selectedSessionId: undefined,
      selectedRuntime: undefined,
      chatTurns: [],
      traceRecords: [],
    });
    const deletion = calls.find(
      (call) => call.url === `/api/v1/sessions/${summary.id}` && call.init?.method === 'DELETE',
    );
    expect(deletion?.init?.body).toBe('{}');
    expect((deletion?.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    transport.dispose();
  });
});
