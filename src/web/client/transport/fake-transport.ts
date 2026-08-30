import type {
  BootstrapDto,
  ChatTurnDto,
  ProviderConfigDto,
  RuntimeCapabilitiesDto,
  SessionRuntimeDto,
  SessionSummaryDto,
  TraceRecordDetailDto,
  TraceRecordDto,
} from '../../../contracts/web.js';

export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';
export type WorkspaceView = 'chat' | 'trace';

export interface ConsoleSnapshot {
  readonly connection: ConnectionState;
  readonly bootstrap: BootstrapDto;
  readonly sessions: readonly SessionSummaryDto[];
  readonly selectedSessionId: string | undefined;
  readonly view: WorkspaceView;
  readonly settingsOpen: boolean;
  readonly selectedTraceRecordId: string | undefined;
  readonly chatTurns: readonly ChatTurnDto[];
  readonly traceRecords: readonly TraceRecordDto[];
  readonly inspectorDetail: TraceRecordDetailDto | undefined;
  readonly selectedRuntime: SessionRuntimeDto | undefined;
  readonly composerText: string;
  readonly providerDraft: ProviderConfigDto;
}

export interface FakeTransportOptions {
  readonly connection?: ConnectionState;
  readonly sessions?: readonly SessionSummaryDto[];
  readonly selectedSessionId?: string;
  readonly view?: WorkspaceView;
  readonly chatTurns?: readonly ChatTurnDto[];
  readonly traceRecords?: readonly TraceRecordDto[];
  readonly inspectorDetails?: Readonly<Record<string, TraceRecordDetailDto>>;
  readonly runtimes?: Readonly<Record<string, SessionRuntimeDto>>;
  readonly provider?: ProviderConfigDto;
  readonly apiKeyConfigured?: boolean;
}

export interface FakeTransport {
  readonly getSnapshot: () => ConsoleSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  createSession(): void;
  selectSession(id: string): void;
  setView(view: WorkspaceView): void;
  setConnection(state: ConnectionState): void;
  openSettings(): void;
  closeSettings(): void;
  selectTraceRecord(id: string | undefined): void;
  setComposerText(text: string): void;
  submitTurn(): void;
  cancelTurn(): void;
  setProviderDraft(draft: ProviderConfigDto): void;
  saveProviderDraft(): void;
}

const DEFAULT_PROVIDER: ProviderConfigDto = {
  baseUrl: 'https://provider.example/v1',
  catalog: { source: 'discover', cachedModels: ['echo-model'] },
  defaultModel: 'echo-model',
  apiKeyConfigured: true,
  writable: true,
};

const DEFAULT_WORKSPACE = {
  name: 'echo-harness',
  fingerprint: 'fp_local_fixture',
} as const;

const DEFAULT_SESSION_CONTEXT: SessionRuntimeDto['context'] = {
  usedApproxTokens: 0,
  limitApproxTokens: 256_000,
};

export function createSessionRuntime(
  summary: SessionSummaryDto,
  context: SessionRuntimeDto['context'] = DEFAULT_SESSION_CONTEXT,
): SessionRuntimeDto {
  return { ...summary, context };
}

export function createIdleSession(overrides: Partial<SessionSummaryDto> = {}): SessionSummaryDto {
  return {
    id: 'ses_idle',
    shortId: 'idle01',
    title: 'Idle planning session',
    updatedAt: '2026-08-30T08:00:00.000Z',
    turnCount: 1,
    phase: 'idle',
    model: 'echo-model',
    safetyMode: 'balanced',
    ...overrides,
  };
}

export function createRunningSession(
  overrides: Partial<SessionSummaryDto> = {},
): SessionSummaryDto {
  return createIdleSession({
    id: 'ses_running',
    shortId: 'run01',
    title: 'Active coding session',
    updatedAt: '2026-08-30T09:00:00.000Z',
    phase: 'running',
    turnCount: 2,
    ...overrides,
  });
}

export function createSampleTraceRecord(overrides: Partial<TraceRecordDto> = {}): TraceRecordDto {
  return {
    id: 'rec_user_1',
    seq: 1,
    turnId: 'turn_1',
    time: '2026-08-30T09:00:01.000Z',
    type: 'user',
    label: '用户',
    status: 'completed',
    parameterSummary: '列出工作区文件',
    hasDetails: true,
    ...overrides,
  };
}

export function createSampleInspectorDetail(
  record: TraceRecordDto = createSampleTraceRecord(),
): TraceRecordDetailDto {
  return {
    ...record,
    sections: [
      {
        key: 'metadata',
        title: '元数据',
        fields: [
          { label: 'Turn', value: record.turnId },
          { label: '状态', value: record.status },
        ],
      },
      {
        key: 'parameters',
        title: '参数',
        fields: [{ label: '目标', value: record.parameterSummary ?? record.label }],
      },
    ],
    relatedRecordIds: [],
  };
}

function deriveCapabilities(
  sessions: readonly SessionSummaryDto[],
  selectedSessionId: string | undefined,
  connection: ConnectionState,
  provider: ProviderConfigDto,
): RuntimeCapabilitiesDto {
  const running = sessions.find((session) => session.phase === 'running');
  const selected = sessions.find((session) => session.id === selectedSessionId);
  const apiReady = connection === 'connected';
  const providerReady = provider.apiKeyConfigured;
  const turnActive = running !== undefined;
  const selectedIsRunning = selected?.phase === 'running';

  let submitTurnBlockedReason: RuntimeCapabilitiesDto['submitTurnBlockedReason'];
  if (!apiReady) {
    submitTurnBlockedReason = 'provider_unavailable';
  } else if (!providerReady) {
    submitTurnBlockedReason = 'provider_unavailable';
  } else if (selected === undefined) {
    submitTurnBlockedReason = 'session_unavailable';
  } else if (turnActive && !selectedIsRunning) {
    submitTurnBlockedReason = 'turn_active';
  }

  return {
    canCreateSession: apiReady,
    canSubmitTurn:
      apiReady &&
      providerReady &&
      selected !== undefined &&
      (!turnActive || selectedIsRunning) &&
      selected.phase !== 'running',
    canChangeRuntime: apiReady && selected !== undefined && !turnActive,
    canCancelTurn: apiReady && selectedIsRunning,
    canRespondToApproval: false,
    ...(running === undefined ? {} : { activeSessionId: running.id, activeTurnId: 'turn_active' }),
    ...(submitTurnBlockedReason === undefined ? {} : { submitTurnBlockedReason }),
    ...(apiReady ? {} : { createSessionBlockedReason: 'provider_unavailable' as const }),
    ...(turnActive ? { changeRuntimeBlockedReason: 'turn_active' as const } : {}),
  };
}

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const listeners = new Set<() => void>();
  let nextSession = 1;
  const sessions = options.sessions ?? [];
  const connection = options.connection ?? 'connected';
  const provider: ProviderConfigDto = {
    ...(options.provider ?? DEFAULT_PROVIDER),
    apiKeyConfigured:
      options.apiKeyConfigured ??
      options.provider?.apiKeyConfigured ??
      DEFAULT_PROVIDER.apiKeyConfigured,
    writable: !(options.sessions ?? []).some((session) => session.phase === 'running'),
  };
  const runtimes: Record<string, SessionRuntimeDto> = { ...(options.runtimes ?? {}) };

  const runtimeFor = (summary: SessionSummaryDto): SessionRuntimeDto => {
    const existing = runtimes[summary.id];
    const next = createSessionRuntime(summary, existing?.context ?? DEFAULT_SESSION_CONTEXT);
    runtimes[summary.id] = next;
    return next;
  };

  for (const session of sessions) {
    runtimeFor(session);
  }

  const selectedRuntimeFor = (
    sessionId: string | undefined,
    sessionList: readonly SessionSummaryDto[],
  ): SessionRuntimeDto | undefined => {
    const selected = sessionList.find((session) => session.id === sessionId);
    return selected === undefined ? undefined : runtimeFor(selected);
  };

  let snapshot: ConsoleSnapshot = {
    connection,
    sessions,
    selectedSessionId: options.selectedSessionId,
    view: options.view ?? 'chat',
    settingsOpen: false,
    selectedTraceRecordId: undefined,
    chatTurns: options.chatTurns ?? [],
    traceRecords: options.traceRecords ?? [],
    inspectorDetail: undefined,
    selectedRuntime: selectedRuntimeFor(options.selectedSessionId, sessions),
    composerText: '',
    providerDraft: provider,
    bootstrap: {
      workspace: DEFAULT_WORKSPACE,
      provider,
      capabilities: deriveCapabilities(sessions, options.selectedSessionId, connection, provider),
    },
  };

  const inspectorDetails = options.inspectorDetails ?? {};

  const emit = (): void => {
    const writable = !snapshot.sessions.some((session) => session.phase === 'running');
    const provider = { ...snapshot.providerDraft, writable };
    snapshot = {
      ...snapshot,
      selectedRuntime: selectedRuntimeFor(snapshot.selectedSessionId, snapshot.sessions),
      providerDraft: provider,
      bootstrap: {
        workspace: DEFAULT_WORKSPACE,
        provider,
        capabilities: deriveCapabilities(
          snapshot.sessions,
          snapshot.selectedSessionId,
          snapshot.connection,
          provider,
        ),
        ...(snapshot.selectedSessionId === undefined
          ? {}
          : { suggestedSessionId: snapshot.selectedSessionId }),
      },
    };
    for (const listener of listeners) {
      listener();
    }
  };

  const replace = (patch: Partial<ConsoleSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    emit();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    createSession(): void {
      if (!snapshot.bootstrap.capabilities.canCreateSession) {
        return;
      }
      const id = `ses_new_${String(nextSession)}`;
      nextSession += 1;
      const created = createIdleSession({
        id,
        shortId: id.slice(-6),
        title: '新会话',
        updatedAt: '2026-08-30T10:00:00.000Z',
        turnCount: 0,
      });
      runtimeFor(created);
      replace({
        sessions: [created, ...snapshot.sessions],
        selectedSessionId: created.id,
        view: 'chat',
        chatTurns: [],
        traceRecords: [],
        selectedTraceRecordId: undefined,
        inspectorDetail: undefined,
        composerText: '',
      });
    },
    selectSession(id: string): void {
      replace({
        selectedSessionId: id,
        selectedTraceRecordId: undefined,
        inspectorDetail: undefined,
      });
    },
    setView(view: WorkspaceView): void {
      replace({
        view,
        ...(view === 'chat'
          ? { selectedTraceRecordId: undefined, inspectorDetail: undefined }
          : {}),
      });
    },
    setConnection(state: ConnectionState): void {
      replace({ connection: state });
    },
    openSettings(): void {
      replace({ settingsOpen: true });
    },
    closeSettings(): void {
      replace({ settingsOpen: false });
    },
    selectTraceRecord(id: string | undefined): void {
      const detail =
        id === undefined
          ? undefined
          : (inspectorDetails[id] ??
            createSampleInspectorDetail(
              snapshot.traceRecords.find((record) => record.id === id) ??
                createSampleTraceRecord({ id }),
            ));
      replace({
        selectedTraceRecordId: id,
        inspectorDetail: detail,
        view: 'trace',
      });
    },
    setComposerText(text: string): void {
      replace({ composerText: text });
    },
    submitTurn(): void {
      const selected = snapshot.sessions.find(
        (session) => session.id === snapshot.selectedSessionId,
      );
      if (selected === undefined || !snapshot.bootstrap.capabilities.canSubmitTurn) {
        return;
      }
      const text = snapshot.composerText.trim();
      if (text.length === 0) {
        return;
      }
      const turn: ChatTurnDto = {
        turnId: 'turn_submitted',
        startedAt: '2026-08-30T10:01:00.000Z',
        userText: text,
        responses: [{ step: 1, text: 'Fake Provider 已接受该 Turn。', partial: false }],
        toolSummaries: [],
        status: 'completed',
      };
      replace({
        composerText: '',
        chatTurns: [...snapshot.chatTurns, turn],
        sessions: snapshot.sessions.map((session) =>
          session.id === selected.id
            ? runtimeFor({
                ...session,
                phase: 'completed',
                turnCount: session.turnCount + 1,
                updatedAt: turn.startedAt,
              })
            : session,
        ),
      });
    },
    cancelTurn(): void {
      if (!snapshot.bootstrap.capabilities.canCancelTurn) {
        return;
      }
      replace({
        sessions: snapshot.sessions.map((session) =>
          session.phase === 'running' ? runtimeFor({ ...session, phase: 'cancelled' }) : session,
        ),
      });
    },
    setProviderDraft(draft: ProviderConfigDto): void {
      replace({ providerDraft: draft });
    },
    saveProviderDraft(): void {
      if (!snapshot.bootstrap.provider.writable) {
        return;
      }
      replace({ settingsOpen: false });
    },
  };
}
