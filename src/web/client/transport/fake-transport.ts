import type {
  ApprovalRequestDto,
  ChatTurnDto,
  ProviderConfigDto,
  RuntimeCapabilitiesDto,
  SessionRuntimeDto,
  SessionSummaryDto,
  TraceRecordDetailDto,
  TraceRecordDto,
  WebErrorCode,
} from '../../../contracts/web.js';
import { projectChatTurns, upsertChatTurn } from '../view-model/chat-projection.js';
import { catalogModels } from '../view-model/provider-catalog.js';
import type {
  ConnectionState,
  ConsoleSnapshot,
  WebConsoleTransport,
  WorkspaceView,
} from './types.js';

export { catalogModels } from '../view-model/provider-catalog.js';
export type { CommandError, ConnectionState, ConsoleSnapshot, WorkspaceView } from './types.js';
export type FakeTurnScript = 'complete' | 'running' | 'approval' | 'stream' | 'fail' | 'limited';

export interface FakeTransportOptions {
  readonly connection?: ConnectionState;
  readonly sessions?: readonly SessionSummaryDto[];
  readonly selectedSessionId?: string;
  readonly view?: WorkspaceView;
  readonly chatTurns?: readonly ChatTurnDto[];
  readonly chatTurnsBySession?: Readonly<Record<string, readonly ChatTurnDto[]>>;
  readonly traceRecords?: readonly TraceRecordDto[];
  readonly inspectorDetails?: Readonly<Record<string, TraceRecordDetailDto>>;
  readonly runtimes?: Readonly<Record<string, SessionRuntimeDto>>;
  readonly provider?: ProviderConfigDto;
  readonly apiKeyConfigured?: boolean;
  readonly turnScript?: FakeTurnScript;
  readonly sessionPageSize?: number;
  readonly discoverableModels?: readonly string[];
  readonly pendingApproval?: ApprovalRequestDto;
  readonly loadingHistory?: boolean;
  readonly resyncRequired?: boolean;
}

export interface FakeTransport extends WebConsoleTransport {
  setConnection(state: ConnectionState): void;
  advanceStream(text: string): void;
  completeActiveTurn(
    status?: Extract<ChatTurnDto['status'], 'completed' | 'failed' | 'cancelled' | 'limited'>,
  ): void;
  requireResync(): void;
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

const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_DISCOVERABLE = ['echo-model', 'echo-fast'] as const;

export function createSessionRuntime(
  summary: SessionSummaryDto,
  context: SessionRuntimeDto['context'] = DEFAULT_SESSION_CONTEXT,
  pendingApproval?: ApprovalRequestDto,
): SessionRuntimeDto {
  return {
    ...summary,
    context,
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  };
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

export function createApprovalRequest(
  overrides: Partial<ApprovalRequestDto> = {},
): ApprovalRequestDto {
  return {
    sessionId: 'ses_running',
    turnId: 'turn_active',
    toolCallId: 'call_1',
    toolName: 'run_command',
    approvalKey: 'apr_run_1',
    actionSummary: '运行工作区内的测试命令',
    riskReason: '该命令会启动本地进程',
    allowedChoices: ['deny', 'allow_once', 'allow_session'],
    ...overrides,
  };
}

export function createSampleChatTurn(overrides: Partial<ChatTurnDto> = {}): ChatTurnDto {
  return {
    turnId: 'turn_1',
    startedAt: '2026-08-30T09:01:00.000Z',
    userText: '列出工作区文件',
    responses: [{ step: 1, text: '已聚合的模型正文。', partial: false }],
    toolSummaries: [],
    status: 'completed',
    ...overrides,
  };
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
  pending: ApprovalRequestDto | undefined,
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
    canRespondToApproval: apiReady && selectedIsRunning && pending !== undefined,
    ...(running === undefined ? {} : { activeSessionId: running.id, activeTurnId: 'turn_active' }),
    ...(submitTurnBlockedReason === undefined ? {} : { submitTurnBlockedReason }),
    ...(apiReady ? {} : { createSessionBlockedReason: 'provider_unavailable' as const }),
    ...(turnActive ? { changeRuntimeBlockedReason: 'turn_active' as const } : {}),
  };
}

function validateProvider(draft: ProviderConfigDto): {
  readonly fields?: Readonly<Record<string, string>>;
  readonly summary?: string;
} {
  const fields: Record<string, string> = {};
  try {
    const parsed = new URL(draft.baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fields.baseUrl = 'Base URL 必须是 http 或 https 地址';
    }
  } catch {
    fields.baseUrl = 'Base URL 无效';
  }
  if (!catalogModels(draft).includes(draft.defaultModel)) {
    fields.defaultModel = '默认模型必须来自当前目录';
  }
  if (Object.keys(fields).length === 0) {
    return {};
  }
  return { fields, summary: '请修正 Provider 设置中的错误。' };
}

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const listeners = new Set<() => void>();
  let nextSession = 1;
  let nextTurn = 1;
  const pageSize = options.sessionPageSize ?? DEFAULT_PAGE_SIZE;
  let visibleCount = pageSize;
  let allSessions = [...(options.sessions ?? [])];
  const connection = options.connection ?? 'connected';
  const turnScript = options.turnScript ?? 'complete';
  const discoverableModels = options.discoverableModels ?? DEFAULT_DISCOVERABLE;
  const consumedApprovals = new Set<string>();
  const pendingBySession: Record<string, ApprovalRequestDto | undefined> = {};
  const chatBySession: Record<string, ChatTurnDto[]> = {};

  let savedProvider: ProviderConfigDto = {
    ...(options.provider ?? DEFAULT_PROVIDER),
    apiKeyConfigured:
      options.apiKeyConfigured ??
      options.provider?.apiKeyConfigured ??
      DEFAULT_PROVIDER.apiKeyConfigured,
    writable: !allSessions.some((session) => session.phase === 'running'),
  };
  const runtimes: Record<string, SessionRuntimeDto> = { ...(options.runtimes ?? {}) };

  const runtimeFor = (summary: SessionSummaryDto): SessionRuntimeDto => {
    const existing = runtimes[summary.id];
    const next = createSessionRuntime(
      summary,
      existing?.context ?? DEFAULT_SESSION_CONTEXT,
      pendingBySession[summary.id],
    );
    runtimes[summary.id] = next;
    return next;
  };

  for (const session of allSessions) {
    runtimeFor(session);
  }

  if (options.pendingApproval !== undefined) {
    pendingBySession[options.pendingApproval.sessionId] = options.pendingApproval;
  }

  for (const [sessionId, turns] of Object.entries(options.chatTurnsBySession ?? {})) {
    chatBySession[sessionId] = [...turns];
  }
  if (options.selectedSessionId !== undefined && options.chatTurns !== undefined) {
    chatBySession[options.selectedSessionId] = [...options.chatTurns];
  } else if (options.chatTurns !== undefined && options.selectedSessionId === undefined) {
    chatBySession._unassigned = [...options.chatTurns];
  }

  const visibleSessions = (): SessionSummaryDto[] => allSessions.slice(0, visibleCount);

  const selectedRuntimeFor = (
    sessionId: string | undefined,
    sessionList: readonly SessionSummaryDto[],
  ): SessionRuntimeDto | undefined => {
    const selected = sessionList.find((session) => session.id === sessionId);
    return selected === undefined ? undefined : runtimeFor(selected);
  };

  const chatsFor = (sessionId: string | undefined): ChatTurnDto[] => {
    if (sessionId === undefined) {
      return projectChatTurns(chatBySession._unassigned ?? []) as ChatTurnDto[];
    }
    return projectChatTurns(chatBySession[sessionId] ?? []) as ChatTurnDto[];
  };

  const storeChats = (sessionId: string | undefined, turns: readonly ChatTurnDto[]): void => {
    chatBySession[sessionId ?? '_unassigned'] = [...turns];
  };

  let snapshot: ConsoleSnapshot = {
    connection,
    sessions: visibleSessions(),
    selectedSessionId: options.selectedSessionId,
    view: options.view ?? 'chat',
    settingsOpen: false,
    selectedTraceRecordId: undefined,
    chatTurns: chatsFor(options.selectedSessionId),
    traceRecords: options.traceRecords ?? [],
    inspectorDetail: undefined,
    selectedRuntime: selectedRuntimeFor(options.selectedSessionId, allSessions),
    composerText: '',
    providerDraft: savedProvider,
    resyncRequired: options.resyncRequired ?? false,
    loadingHistory: options.loadingHistory ?? false,
    hasMoreSessions: allSessions.length > visibleCount,
    bootstrap: {
      workspace: DEFAULT_WORKSPACE,
      provider: savedProvider,
      capabilities: deriveCapabilities(
        allSessions,
        options.selectedSessionId,
        connection,
        savedProvider,
        options.selectedSessionId === undefined
          ? undefined
          : pendingBySession[options.selectedSessionId],
      ),
    },
  };

  const inspectorDetails = options.inspectorDetails ?? {};

  const emit = (): void => {
    const writable = !allSessions.some((session) => session.phase === 'running');
    const selectedPending =
      snapshot.selectedSessionId === undefined
        ? undefined
        : pendingBySession[snapshot.selectedSessionId];
    const provider = { ...snapshot.providerDraft, writable };
    savedProvider = { ...savedProvider, writable };
    snapshot = {
      ...snapshot,
      sessions: visibleSessions(),
      hasMoreSessions: allSessions.length > visibleCount,
      selectedRuntime: selectedRuntimeFor(snapshot.selectedSessionId, allSessions),
      providerDraft: provider,
      bootstrap: {
        workspace: DEFAULT_WORKSPACE,
        provider,
        capabilities: deriveCapabilities(
          allSessions,
          snapshot.selectedSessionId,
          snapshot.connection,
          provider,
          selectedPending,
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

  const replaceSessions = (next: SessionSummaryDto[]): void => {
    allSessions = next;
    for (const session of allSessions) {
      runtimeFor(session);
    }
  };

  const commandError = (code: WebErrorCode, message: string): void => {
    replace({ lastCommandError: { code, message } });
  };

  const transport: FakeTransport = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(): Promise<void> {
      return Promise.resolve();
    },
    dispose(): void {
      listeners.clear();
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
      storeChats(created.id, []);
      replaceSessions([created, ...allSessions]);
      visibleCount = Math.max(visibleCount, 1);
      replace({
        selectedSessionId: created.id,
        view: 'chat',
        chatTurns: [],
        traceRecords: [],
        selectedTraceRecordId: undefined,
        inspectorDetail: undefined,
        composerText: '',
        lastCommandError: undefined,
        resyncRequired: false,
        loadingHistory: false,
      });
    },
    selectSession(id: string): void {
      replace({
        selectedSessionId: id,
        selectedTraceRecordId: undefined,
        inspectorDetail: undefined,
        chatTurns: chatsFor(id),
        lastCommandError: undefined,
        loadingHistory: false,
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
      replace({
        settingsOpen: true,
        providerDraft: { ...savedProvider, catalog: { ...savedProvider.catalog } },
        providerFieldErrors: undefined,
        providerErrorSummary: undefined,
      });
    },
    closeSettings(): void {
      replace({
        settingsOpen: false,
        providerDraft: { ...savedProvider, catalog: { ...savedProvider.catalog } },
        providerFieldErrors: undefined,
        providerErrorSummary: undefined,
      });
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
      const selected = allSessions.find((session) => session.id === snapshot.selectedSessionId);
      if (selected === undefined || !snapshot.bootstrap.capabilities.canSubmitTurn) {
        return;
      }
      const text = snapshot.composerText.trim();
      if (text.length === 0) {
        return;
      }
      const turnId = `turn_${String(nextTurn)}`;
      nextTurn += 1;
      const startedAt = '2026-08-30T10:01:00.000Z';
      let turn: ChatTurnDto;
      let phase: SessionSummaryDto['phase'] = 'completed';
      if (turnScript === 'running' || turnScript === 'stream') {
        phase = 'running';
        turn = {
          turnId,
          startedAt,
          userText: text,
          responses: [
            {
              step: 1,
              text: turnScript === 'stream' ? '' : '正在生成…',
              partial: true,
            },
          ],
          toolSummaries: [],
          status: 'running',
        };
      } else if (turnScript === 'approval') {
        phase = 'running';
        const approval = createApprovalRequest({
          sessionId: selected.id,
          turnId,
          approvalKey: `apr_${turnId}`,
        });
        pendingBySession[selected.id] = approval;
        turn = {
          turnId,
          startedAt,
          userText: text,
          responses: [{ step: 1, text: '需要批准后才能继续。', partial: false }],
          toolSummaries: [
            {
              toolCallId: approval.toolCallId,
              name: approval.toolName,
              status: 'awaiting_approval',
              resultSummary: approval.actionSummary,
            },
          ],
          status: 'running',
        };
      } else if (turnScript === 'fail') {
        phase = 'failed';
        turn = {
          turnId,
          startedAt,
          userText: text,
          responses: [{ step: 1, text: 'Provider 请求失败。', partial: false }],
          toolSummaries: [],
          status: 'failed',
          stopReason: 'provider_error',
        };
      } else if (turnScript === 'limited') {
        phase = 'limited';
        turn = {
          turnId,
          startedAt,
          userText: text,
          responses: [{ step: 1, text: '已达到步数上限。', partial: false }],
          toolSummaries: [],
          status: 'limited',
          stopReason: 'max_steps',
        };
      } else {
        turn = {
          turnId: nextTurn === 2 ? 'turn_submitted' : turnId,
          startedAt,
          userText: text,
          responses: [{ step: 1, text: 'Fake Provider 已接受该 Turn。', partial: false }],
          toolSummaries: [],
          status: 'completed',
        };
      }
      const nextTurns = upsertChatTurn(chatsFor(selected.id), turn);
      storeChats(selected.id, nextTurns);
      replaceSessions(
        allSessions.map((session) =>
          session.id === selected.id
            ? runtimeFor({
                ...session,
                phase,
                turnCount: session.turnCount + 1,
                updatedAt: startedAt,
                title: session.turnCount === 0 ? text.slice(0, 48) : session.title,
              })
            : session,
        ),
      );
      replace({
        composerText: '',
        chatTurns: nextTurns,
        lastCommandError: undefined,
      });
    },
    cancelTurn(): void {
      if (!snapshot.bootstrap.capabilities.canCancelTurn) {
        return;
      }
      const selectedId = snapshot.selectedSessionId;
      const current = chatsFor(selectedId);
      const running = current.find((turn) => turn.status === 'running');
      const nextTurns =
        running === undefined
          ? current
          : upsertChatTurn(current, {
              ...running,
              status: 'cancelled',
              stopReason: 'cancelled',
              responses: running.responses.map((response) => ({ ...response, partial: false })),
              toolSummaries: running.toolSummaries.map((summary) =>
                summary.status === 'running' || summary.status === 'awaiting_approval'
                  ? { ...summary, status: 'cancelled' }
                  : summary,
              ),
            });
      storeChats(selectedId, nextTurns);
      if (selectedId !== undefined) {
        pendingBySession[selectedId] = undefined;
      }
      replaceSessions(
        allSessions.map((session) =>
          session.phase === 'running' ? runtimeFor({ ...session, phase: 'cancelled' }) : session,
        ),
      );
      replace({ chatTurns: nextTurns, lastCommandError: undefined });
    },
    setProviderDraft(draft: ProviderConfigDto): void {
      replace({
        providerDraft: draft,
        providerFieldErrors: undefined,
        providerErrorSummary: undefined,
      });
    },
    saveProviderDraft(): void {
      if (!snapshot.bootstrap.provider.writable) {
        return;
      }
      const invalid = validateProvider(snapshot.providerDraft);
      if (invalid.fields !== undefined) {
        replace({
          providerFieldErrors: invalid.fields,
          providerErrorSummary: invalid.summary,
          settingsOpen: true,
        });
        return;
      }
      savedProvider = {
        ...snapshot.providerDraft,
        writable: true,
        apiKeyConfigured: savedProvider.apiKeyConfigured,
      };
      replace({
        settingsOpen: false,
        providerDraft: savedProvider,
        providerFieldErrors: undefined,
        providerErrorSummary: undefined,
      });
    },
    changeRuntime(update): void {
      if (!snapshot.bootstrap.capabilities.canChangeRuntime) {
        commandError('TURN_ACTIVE', '活动 Turn 存在时不能修改模型或安全模式。');
        return;
      }
      const selectedId = snapshot.selectedSessionId;
      if (selectedId === undefined) {
        return;
      }
      replaceSessions(
        allSessions.map((session) =>
          session.id === selectedId
            ? runtimeFor({
                ...session,
                ...(update.model === undefined ? {} : { model: update.model }),
                ...(update.safetyMode === undefined ? {} : { safetyMode: update.safetyMode }),
              })
            : session,
        ),
      );
      emit();
    },
    respondToApproval(decision): void {
      const selectedId = snapshot.selectedSessionId;
      const pending = selectedId === undefined ? undefined : pendingBySession[selectedId];
      if (
        selectedId === undefined ||
        pending === undefined ||
        !snapshot.bootstrap.capabilities.canRespondToApproval
      ) {
        commandError('APPROVAL_NOT_PENDING', '审批已处理或已过期，未再次执行工具。');
        return;
      }
      if (consumedApprovals.has(pending.approvalKey)) {
        commandError('APPROVAL_DUPLICATE', '重复审批已忽略，未再次执行工具。');
        return;
      }
      consumedApprovals.add(pending.approvalKey);
      pendingBySession[selectedId] = undefined;
      const current = chatsFor(selectedId);
      const running = current.find((turn) => turn.turnId === pending.turnId) ?? current.at(-1);
      const toolStatus =
        decision === 'deny'
          ? 'denied'
          : decision === 'allow_once' || decision === 'allow_session'
            ? 'completed'
            : 'denied';
      const nextTurns =
        running === undefined
          ? current
          : upsertChatTurn(current, {
              ...running,
              status: decision === 'deny' ? 'cancelled' : 'completed',
              ...(decision === 'deny' ? { stopReason: 'approval_denied' } : {}),
              toolSummaries: running.toolSummaries.map((summary) =>
                summary.toolCallId === pending.toolCallId
                  ? {
                      ...summary,
                      status: toolStatus,
                      resultSummary: decision === 'deny' ? '用户拒绝' : '已按审批决定继续',
                    }
                  : summary,
              ),
            });
      storeChats(selectedId, nextTurns);
      replaceSessions(
        allSessions.map((session) =>
          session.id === selectedId
            ? runtimeFor({
                ...session,
                phase: decision === 'deny' ? 'cancelled' : 'completed',
              })
            : session,
        ),
      );
      replace({ chatTurns: nextTurns, lastCommandError: undefined });
    },
    discoverModels(): void {
      if (!snapshot.providerDraft.writable) {
        return;
      }
      const draft = snapshot.providerDraft;
      replace({
        providerDraft: {
          ...draft,
          catalog: { source: 'discover', cachedModels: [...discoverableModels] },
        },
        lastDiscoveredAt: '2026-08-30T11:00:00.000Z',
        providerFieldErrors: undefined,
        providerErrorSummary: undefined,
      });
    },
    loadMoreSessions(): void {
      if (visibleCount >= allSessions.length) {
        return;
      }
      visibleCount += pageSize;
      emit();
    },
    advanceStream(text: string): void {
      const selectedId = snapshot.selectedSessionId;
      const current = chatsFor(selectedId);
      const running = current.find((turn) => turn.status === 'running');
      if (running === undefined) {
        return;
      }
      const nextTurns = upsertChatTurn(current, {
        ...running,
        responses: [{ step: 1, text, partial: true }],
      });
      storeChats(selectedId, nextTurns);
      replace({ chatTurns: nextTurns });
    },
    completeActiveTurn(status = 'completed'): void {
      const selectedId = snapshot.selectedSessionId;
      const current = chatsFor(selectedId);
      const running = current.find((turn) => turn.status === 'running');
      if (running === undefined) {
        return;
      }
      const nextTurns = upsertChatTurn(current, {
        ...running,
        status,
        responses: running.responses.map((response) => ({ ...response, partial: false })),
      });
      storeChats(selectedId, nextTurns);
      if (selectedId !== undefined) {
        pendingBySession[selectedId] = undefined;
      }
      replaceSessions(
        allSessions.map((session) =>
          session.id === selectedId ? runtimeFor({ ...session, phase: status }) : session,
        ),
      );
      replace({ chatTurns: nextTurns });
    },
    requireResync(): void {
      replace({ resyncRequired: true, connection: 'reconnecting' });
    },
    resyncFromSnapshot(): void {
      replace({
        resyncRequired: false,
        loadingHistory: false,
        connection: 'connected',
        chatTurns: chatsFor(snapshot.selectedSessionId),
        lastCommandError: undefined,
      });
    },
  };

  return transport;
}
