import type {
  AcceptedTurnDto,
  ApiErrorResponse,
  ApiResponse,
  ApprovalChoiceDto,
  BootstrapDto,
  ChatTurnDto,
  DeletedSessionDto,
  DiscoveredModelsDto,
  ExtensionMutationDto,
  ExtensionSummaryDto,
  Page,
  ProviderConfigDto,
  SessionSummaryDto,
  SessionViewDto,
  TraceRecordDetailDto,
  TraceRecordDto,
  UpdateSessionRuntimeRequest,
  WebStreamEvent,
} from '../../../contracts/web.js';
import { upsertChatTurn } from '../view-model/chat-projection.js';
import type { ConsoleSnapshot, WebConsoleTransport, WorkspaceView } from './types.js';

const EMPTY_PROVIDER: ProviderConfigDto = {
  baseUrl: 'https://provider.invalid/v1',
  catalog: { source: 'discover', cachedModels: [] },
  defaultModel: '',
  apiKeyConfigured: false,
  writable: false,
};

const EMPTY_BOOTSTRAP: BootstrapDto = {
  workspace: { name: 'workspace', fingerprint: 'pending' },
  provider: EMPTY_PROVIDER,
  capabilities: {
    canCreateSession: false,
    canSubmitTurn: false,
    canChangeRuntime: false,
    canCancelTurn: false,
    canRespondToApproval: false,
    createSessionBlockedReason: 'provider_unavailable',
    submitTurnBlockedReason: 'provider_unavailable',
    changeRuntimeBlockedReason: 'provider_unavailable',
  },
};

function requestId(): string {
  return `web_${crypto.randomUUID()}`;
}

function apiError(value: unknown): ApiErrorResponse | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorResponse).error?.code === 'string'
  ) {
    return value as ApiErrorResponse;
  }
  return undefined;
}

function sessionSummary(view: SessionViewDto): SessionSummaryDto {
  return view.session;
}

function upsertSession(
  sessions: readonly SessionSummaryDto[],
  session: SessionSummaryDto,
): SessionSummaryDto[] {
  return [session, ...sessions.filter((item) => item.id !== session.id)].toSorted((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function upsertTrace(
  records: readonly TraceRecordDto[],
  incoming: readonly TraceRecordDto[],
): TraceRecordDto[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of incoming) {
    const previous = byId.get(record.id);
    if (previous === undefined || record.seq >= previous.seq) byId.set(record.id, record);
  }
  return [...byId.values()].toSorted((left, right) =>
    left.seq === right.seq ? left.id.localeCompare(right.id) : left.seq - right.seq,
  );
}

export function createHttpTransport(): WebConsoleTransport {
  const listeners = new Set<() => void>();
  let eventSource: EventSource | undefined;
  let sessionCursor: string | undefined;
  const lastSeqBySession = new Map<string, number>();
  let started: Promise<void> | undefined;
  let disposed = false;
  let snapshot: ConsoleSnapshot = {
    connection: 'reconnecting',
    bootstrap: EMPTY_BOOTSTRAP,
    sessions: [],
    selectedSessionId: undefined,
    view: 'chat',
    settingsOpen: false,
    selectedTraceRecordId: undefined,
    chatTurns: [],
    traceRecords: [],
    inspectorDetail: undefined,
    selectedRuntime: undefined,
    composerText: '',
    providerDraft: EMPTY_PROVIDER,
    resyncRequired: false,
    loadingHistory: true,
    hasMoreSessions: false,
    extensions: [],
    extensionsAvailable: false,
    extensionsLoading: false,
  };

  const emit = (patch: Partial<ConsoleSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const request = async <T>(
    url: string,
    options: { readonly method?: string; readonly body?: unknown } = {},
  ): Promise<T> => {
    const method = options.method ?? 'GET';
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.body === undefined
        ? {}
        : {
            headers: {
              'Content-Type': 'application/json',
              'X-Echo-Request-Id': requestId(),
            },
            body: JSON.stringify(options.body),
          }),
    });
    const value = response.status === 204 ? undefined : await response.json();
    if (!response.ok) {
      const error = apiError(value);
      throw error ?? new Error(`HTTP ${String(response.status)}`);
    }
    return value as T;
  };

  const reportError = (error: unknown, approval = false): void => {
    const parsed = apiError(error);
    const message = parsed?.error.message ?? '本地 Web API 请求失败。';
    emit({
      ...(parsed === undefined ? { connection: 'disconnected' as const } : {}),
      ...(approval
        ? { approvalError: message }
        : {
            lastCommandError: {
              code: parsed?.error.code ?? 'INTERNAL_ERROR',
              message,
            },
          }),
    });
  };

  const extensionErrorMessage = (error: unknown): string =>
    apiError(error)?.error.message ?? '扩展管理请求失败，现有状态未改变。';

  const loadExtensions = async (): Promise<void> => {
    emit({ extensionsLoading: true, extensionError: undefined, extensionNotice: undefined });
    try {
      const response =
        await request<ApiResponse<readonly ExtensionSummaryDto[]>>('/api/v1/extensions');
      emit({
        extensions: response.data,
        extensionsAvailable: true,
        extensionsLoading: false,
        extensionError: undefined,
      });
    } catch (error) {
      const parsed = apiError(error);
      const unavailable =
        parsed?.error.code === 'NOT_FOUND' ||
        (parsed?.error.code === 'EXTENSION_INVALID' &&
          parsed.error.message.includes('unavailable'));
      emit({
        extensionsLoading: false,
        ...(unavailable
          ? { extensionsAvailable: false, extensions: [] }
          : {
              extensionsAvailable: true,
              extensionError: extensionErrorMessage(error),
            }),
      });
    }
  };

  const mutateExtension = (
    extensionId: string,
    method: 'POST' | 'DELETE',
    suffix: '' | '/enable' | '/disable',
  ): void => {
    run(async () => {
      emit({
        extensionPendingId: extensionId,
        extensionError: undefined,
        extensionNotice: undefined,
      });
      try {
        const response = await request<ApiResponse<ExtensionMutationDto>>(
          `/api/v1/extensions/${encodeURIComponent(extensionId)}${suffix}`,
          { method, body: {} },
        );
        const mutation = response.data;
        let extensions: readonly ExtensionSummaryDto[];
        if (mutation.state === 'absent') {
          extensions = snapshot.extensions.filter((extension) => extension.id !== extensionId);
        } else {
          const state = mutation.state;
          extensions = snapshot.extensions.map((extension) =>
            extension.id === extensionId
              ? {
                  ...extension,
                  state,
                  loaded: mutation.loaded,
                  ...(mutation.contentHash === undefined
                    ? {}
                    : { contentHash: mutation.contentHash }),
                  cleanupPending: mutation.cleanupPending,
                }
              : extension,
          );
        }
        const notice = mutation.cleanupPending
          ? '扩展已停用，但物理清理仍待完成。'
          : mutation.state === 'absent'
            ? '扩展已卸载。'
            : mutation.state === 'enabled'
              ? '扩展已启用。'
              : '扩展已禁用。';
        emit({
          extensions,
          extensionPendingId: undefined,
          extensionNotice: notice,
          extensionError: undefined,
        });
      } catch (error) {
        emit({
          extensionPendingId: undefined,
          extensionError: extensionErrorMessage(error),
        });
      }
    });
  };

  const loadSelected = async (sessionId: string): Promise<void> => {
    emit({ loadingHistory: true });
    const [viewResponse, chatResponse, traceResponse] = await Promise.all([
      request<ApiResponse<SessionViewDto>>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`),
      request<ApiResponse<Page<ChatTurnDto>>>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/chat?limit=100`,
      ),
      request<ApiResponse<Page<TraceRecordDto>>>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/trace?after=0&limit=200`,
      ),
    ]);
    lastSeqBySession.set(sessionId, traceResponse.data.items.at(-1)?.seq ?? 0);
    emit({
      selectedSessionId: sessionId,
      selectedRuntime: viewResponse.data.session,
      bootstrap: { ...snapshot.bootstrap, capabilities: viewResponse.data.capabilities },
      sessions: upsertSession(snapshot.sessions, sessionSummary(viewResponse.data)),
      chatTurns: chatResponse.data.items,
      traceRecords: traceResponse.data.items,
      selectedTraceRecordId: undefined,
      inspectorDetail: undefined,
      loadingHistory: false,
      resyncRequired: false,
    });
    connectStream(
      viewResponse.data.capabilities.activeSessionId ??
        (snapshot.selectedSessionId === sessionId ? sessionId : undefined),
    );
  };

  const applyStream = (event: WebStreamEvent): void => {
    if (event.type === 'resync.required') {
      eventSource?.close();
      eventSource = undefined;
      emit({ connection: 'reconnecting', resyncRequired: true });
      return;
    }
    lastSeqBySession.set(
      event.sessionId,
      Math.max(lastSeqBySession.get(event.sessionId) ?? 0, event.seq),
    );
    const selected = snapshot.selectedSessionId === event.sessionId;
    const session = event.delta.view.session;
    emit({
      sessions: upsertSession(snapshot.sessions, session),
      bootstrap: {
        ...snapshot.bootstrap,
        capabilities:
          selected || event.type === 'turn.terminal'
            ? event.delta.view.capabilities
            : snapshot.bootstrap.capabilities,
      },
      ...(selected
        ? {
            selectedRuntime: session,
            chatTurns:
              event.delta.chatTurn === undefined
                ? snapshot.chatTurns
                : upsertChatTurn(snapshot.chatTurns, event.delta.chatTurn),
            traceRecords:
              event.delta.traceRecords === undefined
                ? snapshot.traceRecords
                : upsertTrace(snapshot.traceRecords, event.delta.traceRecords),
          }
        : {}),
      approvalError: undefined,
      lastCommandError: undefined,
    });
  };

  function connectStream(sessionId: string | undefined): void {
    eventSource?.close();
    eventSource = undefined;
    if (disposed || sessionId === undefined) {
      emit({ connection: 'connected' });
      return;
    }
    emit({ connection: 'reconnecting' });
    const stream = new EventSource(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${String(lastSeqBySession.get(sessionId) ?? 0)}`,
      { withCredentials: true },
    );
    eventSource = stream;
    stream.onopen = () => {
      if (eventSource === stream) emit({ connection: 'connected' });
    };
    stream.onerror = () => {
      if (eventSource === stream) emit({ connection: 'reconnecting' });
    };
    for (const type of [
      'session.updated',
      'record.upsert',
      'approval.pending',
      'turn.terminal',
      'resync.required',
    ] as const) {
      stream.addEventListener(type, (message) => {
        try {
          applyStream(JSON.parse((message as MessageEvent<string>).data) as WebStreamEvent);
        } catch {
          emit({ connection: 'disconnected', resyncRequired: true });
        }
      });
    }
  }

  const run = (work: () => Promise<void>, approval = false): void => {
    void work().catch((error: unknown) => {
      reportError(error, approval);
    });
  };

  const transport: WebConsoleTransport = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      started ??= (async () => {
        const token = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
        if (token !== null) {
          await request<undefined>('/api/v1/auth/bootstrap', {
            method: 'POST',
            body: { token },
          });
          history.replaceState(null, '', `${location.pathname}${location.search}`);
        }
        const [bootstrapResponse, sessionsResponse] = await Promise.all([
          request<ApiResponse<BootstrapDto>>('/api/v1/bootstrap'),
          request<ApiResponse<Page<SessionSummaryDto>>>('/api/v1/sessions?limit=30'),
        ]);
        sessionCursor = sessionsResponse.data.nextCursor;
        const sessions = sessionsResponse.data.items;
        const selectedId = bootstrapResponse.data.suggestedSessionId ?? sessions[0]?.id;
        emit({
          connection: 'connected',
          bootstrap: bootstrapResponse.data,
          sessions,
          providerDraft: bootstrapResponse.data.provider,
          hasMoreSessions: sessionCursor !== undefined,
          loadingHistory: selectedId !== undefined,
        });
        if (selectedId !== undefined) await loadSelected(selectedId);
      })().catch((error: unknown) => {
        reportError(error);
        throw error;
      });
      return started;
    },
    dispose() {
      disposed = true;
      eventSource?.close();
      eventSource = undefined;
    },
    createSession() {
      run(async () => {
        const response = await request<ApiResponse<SessionViewDto>>('/api/v1/sessions', {
          method: 'POST',
          body: {},
        });
        emit({ sessions: upsertSession(snapshot.sessions, response.data.session) });
        await loadSelected(response.data.session.id);
      });
    },
    async deleteSession(id) {
      let response: ApiResponse<DeletedSessionDto>;
      try {
        response = await request<ApiResponse<DeletedSessionDto>>(
          `/api/v1/sessions/${encodeURIComponent(id)}`,
          { method: 'DELETE', body: {} },
        );
      } catch (error) {
        reportError(error);
        const parsed = apiError(error);
        throw new Error(parsed?.error.message ?? '会话删除失败，请重试。', { cause: error });
      }

      let remaining = snapshot.sessions.filter((session) => session.id !== id);
      let sessionListRefreshed = false;
      lastSeqBySession.delete(id);
      try {
        const sessionsResponse = await request<ApiResponse<Page<SessionSummaryDto>>>(
          '/api/v1/sessions?limit=30',
        );
        sessionCursor = sessionsResponse.data.nextCursor;
        remaining = [...sessionsResponse.data.items];
        sessionListRefreshed = true;
      } catch (error) {
        sessionCursor = undefined;
        reportError(error);
      }

      if (snapshot.selectedSessionId === id) {
        const next = remaining[0];
        emit({
          sessions: remaining,
          hasMoreSessions: sessionCursor !== undefined,
          lastCommandError: undefined,
        });
        if (next !== undefined) {
          try {
            await loadSelected(next.id);
          } catch (error) {
            emit({
              selectedSessionId: next.id,
              selectedRuntime: undefined,
              chatTurns: [],
              traceRecords: [],
              selectedTraceRecordId: undefined,
              inspectorDetail: undefined,
              loadingHistory: false,
            });
            reportError(error);
          }
          return;
        }
        eventSource?.close();
        eventSource = undefined;
        emit({
          ...(sessionListRefreshed ? { connection: 'connected' as const } : {}),
          sessions: [],
          hasMoreSessions: false,
          selectedSessionId: undefined,
          selectedRuntime: undefined,
          chatTurns: [],
          traceRecords: [],
          selectedTraceRecordId: undefined,
          inspectorDetail: undefined,
          composerText: '',
          resyncRequired: false,
          loadingHistory: false,
          lastCommandError: undefined,
          bootstrap: {
            ...snapshot.bootstrap,
            capabilities: {
              canCreateSession: snapshot.connection === 'connected',
              canSubmitTurn: false,
              canChangeRuntime: false,
              canCancelTurn: false,
              canRespondToApproval: false,
              submitTurnBlockedReason: 'session_unavailable',
              changeRuntimeBlockedReason: 'session_unavailable',
            },
          },
        });
        return;
      }
      emit({
        sessions: remaining,
        hasMoreSessions: sessionCursor !== undefined,
        lastCommandError: undefined,
      });
      if (response.data.stoppedActiveTurn && snapshot.selectedSessionId !== undefined) {
        try {
          await loadSelected(snapshot.selectedSessionId);
        } catch (error) {
          reportError(error);
        }
      }
    },
    selectSession(id) {
      run(() => loadSelected(id));
    },
    setView(view: WorkspaceView) {
      emit({
        view,
        ...(view === 'chat'
          ? { selectedTraceRecordId: undefined, inspectorDetail: undefined }
          : {}),
      });
    },
    openSettings() {
      run(async () => {
        const response = await request<ApiResponse<ProviderConfigDto>>('/api/v1/provider');
        emit({
          settingsOpen: true,
          providerDraft: response.data,
          providerFieldErrors: undefined,
          providerErrorSummary: undefined,
        });
        await loadExtensions();
      });
    },
    closeSettings() {
      emit({
        settingsOpen: false,
        providerDraft: snapshot.bootstrap.provider,
        providerFieldErrors: undefined,
        providerErrorSummary: undefined,
      });
    },
    selectTraceRecord(id) {
      if (id === undefined) {
        emit({ selectedTraceRecordId: undefined, inspectorDetail: undefined });
        return;
      }
      const sessionId = snapshot.selectedSessionId;
      if (sessionId === undefined) return;
      run(async () => {
        const response = await request<ApiResponse<TraceRecordDetailDto>>(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/trace/${encodeURIComponent(id)}`,
        );
        emit({ selectedTraceRecordId: id, inspectorDetail: response.data, view: 'trace' });
      });
    },
    setComposerText(text) {
      emit({ composerText: text });
    },
    submitTurn() {
      const sessionId = snapshot.selectedSessionId;
      const text = snapshot.composerText.trim();
      if (sessionId === undefined || text.length === 0) return;
      run(async () => {
        await request<ApiResponse<AcceptedTurnDto>>(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
          {
            method: 'POST',
            body: { text },
          },
        );
        emit({ composerText: '' });
      });
    },
    cancelTurn() {
      const sessionId = snapshot.bootstrap.capabilities.activeSessionId;
      const turnId = snapshot.bootstrap.capabilities.activeTurnId;
      if (sessionId === undefined || turnId === undefined) return;
      run(async () => {
        await request(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
          { method: 'POST', body: {} },
        );
      });
    },
    setProviderDraft(draft) {
      emit({
        providerDraft: draft,
        providerFieldErrors: undefined,
        providerErrorSummary: undefined,
      });
    },
    saveProviderDraft() {
      const draft = snapshot.providerDraft;
      run(async () => {
        const catalog =
          draft.catalog.source === 'discover'
            ? { source: 'discover' as const }
            : { source: 'manual' as const, models: draft.catalog.models };
        const response = await request<ApiResponse<ProviderConfigDto>>('/api/v1/provider', {
          method: 'PUT',
          body: { baseUrl: draft.baseUrl, catalog, defaultModel: draft.defaultModel },
        });
        emit({
          settingsOpen: false,
          providerDraft: response.data,
          bootstrap: { ...snapshot.bootstrap, provider: response.data },
          providerFieldErrors: undefined,
          providerErrorSummary: undefined,
        });
      });
    },
    changeRuntime(update: UpdateSessionRuntimeRequest) {
      const sessionId = snapshot.selectedSessionId;
      if (sessionId === undefined) return;
      run(async () => {
        const response = await request<ApiResponse<SessionViewDto>>(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/runtime`,
          { method: 'PATCH', body: update },
        );
        emit({
          selectedRuntime: response.data.session,
          sessions: upsertSession(snapshot.sessions, response.data.session),
          bootstrap: { ...snapshot.bootstrap, capabilities: response.data.capabilities },
        });
      });
    },
    respondToApproval(decision: ApprovalChoiceDto) {
      const approval = snapshot.selectedRuntime?.pendingApproval;
      if (approval === undefined) return;
      run(async () => {
        await request(
          `/api/v1/sessions/${encodeURIComponent(approval.sessionId)}/approvals/${encodeURIComponent(approval.approvalKey)}`,
          {
            method: 'POST',
            body: {
              turnId: approval.turnId,
              toolCallId: approval.toolCallId,
              decision,
            },
          },
        );
        emit({ approvalError: undefined });
      }, true);
    },
    discoverModels() {
      run(async () => {
        const response = await request<ApiResponse<DiscoveredModelsDto>>(
          '/api/v1/provider/discover',
          { method: 'POST', body: { baseUrl: snapshot.providerDraft.baseUrl } },
        );
        emit({
          providerDraft: {
            ...snapshot.providerDraft,
            catalog: { source: 'discover', cachedModels: response.data.models },
          },
          lastDiscoveredAt: response.data.fetchedAt,
        });
      });
    },
    loadMoreSessions() {
      if (sessionCursor === undefined) return;
      run(async () => {
        const response = await request<ApiResponse<Page<SessionSummaryDto>>>(
          `/api/v1/sessions?limit=30&cursor=${encodeURIComponent(sessionCursor ?? '')}`,
        );
        sessionCursor = response.data.nextCursor;
        emit({
          sessions: [...snapshot.sessions, ...response.data.items],
          hasMoreSessions: sessionCursor !== undefined,
        });
      });
    },
    resyncFromSnapshot() {
      const sessionId = snapshot.selectedSessionId;
      if (sessionId !== undefined) run(() => loadSelected(sessionId));
    },
    refreshExtensions() {
      run(loadExtensions);
    },
    enableExtension(extensionId) {
      mutateExtension(extensionId, 'POST', '/enable');
    },
    disableExtension(extensionId) {
      mutateExtension(extensionId, 'POST', '/disable');
    },
    uninstallExtension(extensionId) {
      mutateExtension(extensionId, 'DELETE', '');
    },
  };

  return transport;
}
