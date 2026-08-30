import type {
  ApprovalRequestDto,
  ChatTurnDto,
  TraceRecordDetailDto,
  TraceRecordDto,
  TraceRecordType,
} from '../../src/contracts/web.js';
import { FakeProvider } from '../../src/provider/index.js';
import {
  createFakeTransport,
  createIdleSession,
  createRunningSession,
  createSampleInspectorDetail,
  createSampleTraceRecord,
  createSessionRuntime,
  type FakeTransport,
} from '../../src/web/client/transport/fake-transport.js';

export const WEB_SCENARIO_NAMES = [
  'empty',
  'first-session',
  'approval',
  'completed',
  'disconnected',
  'reconnecting',
  'provider-secret',
  'large-trace',
  'keyboard',
] as const;

export type WebScenarioName = (typeof WEB_SCENARIO_NAMES)[number];

const TRACE_TYPES: readonly TraceRecordType[] = [
  'user',
  'context',
  'agent',
  'tool',
  'policy',
  'approval',
  'verification',
  'turn',
];

export const FAKE_WEB_APPROVAL: ApprovalRequestDto = {
  sessionId: 'ses_running',
  turnId: 'turn_ask',
  toolCallId: 'call_ask_1',
  toolName: 'run_command',
  approvalKey: 'run_command:pnpm-test',
  actionSummary: '在工作区运行测试',
  riskReason: '命令可能修改文件',
  allowedChoices: ['deny', 'allow_once', 'allow_session'],
};

export function createWebChatFakeProvider(): FakeProvider {
  return new FakeProvider([
    {
      events: [
        { type: 'text_delta', delta: 'Fake Provider 已接受该 Turn。' },
        { type: 'completed', finishReason: 'stop' },
      ],
    },
  ]);
}

export function createWebApprovalFakeProvider(): FakeProvider {
  return new FakeProvider([
    {
      events: [
        {
          type: 'tool_call',
          call: {
            id: 'call_ask_1',
            name: 'run_command',
            arguments: { command: 'pnpm test' },
          },
        },
        { type: 'completed', finishReason: 'tool_calls' },
      ],
    },
  ]);
}

export function createCompletedChatTurn(): ChatTurnDto {
  return {
    turnId: 'turn_done',
    startedAt: '2026-08-30T10:01:00.000Z',
    userText: '列出工作区文件',
    responses: [{ step: 1, text: 'Fake Provider 已接受该 Turn。', partial: false }],
    toolSummaries: [],
    status: 'completed',
    stopReason: 'completed',
  };
}

export function createApprovalChatTurn(): ChatTurnDto {
  return {
    turnId: 'turn_ask',
    startedAt: '2026-08-30T10:02:00.000Z',
    userText: '运行测试',
    responses: [{ step: 1, text: '需要审批后才能执行命令。', partial: true }],
    toolSummaries: [
      {
        toolCallId: 'call_ask_1',
        name: 'run_command',
        status: 'awaiting_approval',
        resultSummary: '等待用户选择拒绝、仅本次或本 Session',
      },
    ],
    status: 'running',
  };
}

export function createLargeTraceRecords(count = 200): readonly TraceRecordDto[] {
  return Array.from({ length: count }, (_, index) => {
    const type = TRACE_TYPES[index % TRACE_TYPES.length] ?? 'user';
    const seq = index + 1;
    return createSampleTraceRecord({
      id: `rec_large_${String(seq)}`,
      seq,
      turnId: `turn_${String(Math.floor(index / 8) + 1)}`,
      time: `2026-08-30T11:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      type,
      label: type,
      status: index === count - 1 ? 'running' : 'completed',
      parameterSummary: `fixture-${type}-${String(seq)}`,
    });
  });
}

function inspectorMap(
  records: readonly TraceRecordDto[],
): Readonly<Record<string, TraceRecordDetailDto>> {
  const details: Record<string, TraceRecordDetailDto> = {};
  for (const record of records) {
    details[record.id] = createSampleInspectorDetail(record);
  }
  return details;
}

export function createWebScenarioTransport(name: WebScenarioName): FakeTransport {
  switch (name) {
    case 'empty':
      return createFakeTransport();
    case 'first-session':
      return createFakeTransport({
        sessions: [createIdleSession({ turnCount: 0, title: '新会话' })],
        selectedSessionId: 'ses_idle',
      });
    case 'approval': {
      const running = createRunningSession();
      const approvalRecord = createSampleTraceRecord({
        id: 'rec_approval_1',
        seq: 2,
        type: 'approval',
        label: '审批',
        status: 'running',
        parameterSummary: FAKE_WEB_APPROVAL.actionSummary,
      });
      return createFakeTransport({
        sessions: [running, createIdleSession()],
        selectedSessionId: running.id,
        chatTurns: [createApprovalChatTurn()],
        traceRecords: [
          createSampleTraceRecord({ id: 'rec_user_ask', seq: 1, parameterSummary: '运行测试' }),
          approvalRecord,
        ],
        inspectorDetails: inspectorMap([approvalRecord]),
        runtimes: {
          [running.id]: {
            ...createSessionRuntime(running),
            pendingApproval: FAKE_WEB_APPROVAL,
          },
        },
      });
    }
    case 'completed':
      return createFakeTransport({
        sessions: [createIdleSession({ phase: 'completed', turnCount: 2 })],
        selectedSessionId: 'ses_idle',
        chatTurns: [createCompletedChatTurn()],
      });
    case 'disconnected':
      return createFakeTransport({ connection: 'disconnected' });
    case 'reconnecting':
      return createFakeTransport({
        connection: 'reconnecting',
        sessions: [createIdleSession()],
        selectedSessionId: 'ses_idle',
      });
    case 'provider-secret':
      return createFakeTransport({
        sessions: [createIdleSession()],
        selectedSessionId: 'ses_idle',
        apiKeyConfigured: true,
        provider: {
          baseUrl: 'https://provider.example/v1',
          catalog: { source: 'discover', cachedModels: ['echo-model'] },
          defaultModel: 'echo-model',
          apiKeyConfigured: true,
          writable: true,
        },
      });
    case 'large-trace': {
      const records = createLargeTraceRecords();
      return createFakeTransport({
        sessions: [createIdleSession({ turnCount: 25 })],
        selectedSessionId: 'ses_idle',
        view: 'trace',
        traceRecords: records,
        inspectorDetails: inspectorMap(records.slice(0, 8)),
      });
    }
    case 'keyboard':
      return createFakeTransport({
        sessions: [createIdleSession()],
        selectedSessionId: 'ses_idle',
      });
  }
}

export function isWebScenarioName(value: string): value is WebScenarioName {
  return (WEB_SCENARIO_NAMES as readonly string[]).includes(value);
}
