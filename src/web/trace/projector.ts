import type { EchoEvent, ToolResultMessage } from '../../contracts/index.js';
import type { TraceRecordDetailDto, TraceRecordDto, TraceRecordType } from '../../contracts/web.js';
import { WEB_BOUNDS } from '../../contracts/web.js';
import { policyExplainForToolCall } from '../../session/policy-explain.js';

import { traceRecordId } from './ids.js';
import {
  bodyText,
  boundText,
  dropSensitive,
  fieldText,
  metaBoolean,
  metaNumber,
  metaString,
  relativeWorkspacePath,
  summarizeUnknown,
  TRACE_UNAVAILABLE,
  type ProjectionRedaction,
} from './sanitize.js';

export const TRACE_TYPE_LABELS: Record<TraceRecordType, string> = {
  user: '用户',
  context: '上下文',
  agent: '代理',
  tool: '工具',
  policy: '策略',
  approval: '审批',
  verification: '验证',
  turn: 'Turn',
};

export interface TraceProjection {
  readonly records: readonly TraceRecordDto[];
  readonly details: Readonly<Record<string, TraceRecordDetailDto>>;
}

type DetailSection = TraceRecordDetailDto['sections'][number];
type DetailField = NonNullable<DetailSection['fields']>[number];

interface DraftRecord {
  id: string;
  seq: number;
  turnId: string;
  step?: number;
  time: string;
  durationMs?: number;
  type: TraceRecordType;
  label: string;
  status: string;
  parameterSummary?: string;
  resultSummary?: string;
  agentText: string;
  related: Set<string>;
}

interface ProjectorState {
  readonly redaction: ProjectionRedaction;
  readonly drafts: Map<string, DraftRecord>;
  readonly stepNumber: Map<string, number>;
  readonly toolName: Map<string, string>;
  readonly toolInput: Map<string, unknown>;
  readonly toolCommand: Map<string, string>;
  readonly lastVerification: Map<string, string>;
  readonly agentStartedAt: Map<string, number>;
  readonly turnStartedAt: Map<string, number>;
}

function text(state: ProjectorState, value: string, max: number = WEB_BOUNDS.textMax): string {
  return fieldText(value, max, state.redaction);
}

function field(
  redaction: ProjectionRedaction,
  label: string,
  value: string | undefined,
): DetailField | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return { label, value: fieldText(value, WEB_BOUNDS.textMax, redaction) };
}

function fieldsOf(...items: readonly (DetailField | undefined)[]): DetailField[] {
  return items.filter((item): item is DetailField => item !== undefined);
}

function section(
  key: DetailSection['key'],
  title: string,
  parts: {
    readonly fields?: readonly DetailField[];
    readonly code?: DetailSection['code'];
    readonly diff?: DetailSection['diff'];
  },
): DetailSection | undefined {
  const fields = parts.fields === undefined || parts.fields.length === 0 ? undefined : parts.fields;
  if (fields === undefined && parts.code === undefined && parts.diff === undefined) {
    return undefined;
  }
  return {
    key,
    title,
    ...(fields === undefined ? {} : { fields }),
    ...(parts.code === undefined ? {} : { code: parts.code }),
    ...(parts.diff === undefined ? {} : { diff: parts.diff }),
  };
}

function turnIdOf(event: EchoEvent): string {
  return event.turnId ?? 'turn-none';
}

function stepOf(state: ProjectorState, event: EchoEvent): number | undefined {
  if (event.stepId === undefined) return undefined;
  return state.stepNumber.get(event.stepId);
}

function upsert(
  state: ProjectorState,
  event: EchoEvent,
  type: TraceRecordType,
  id: string,
  patch: Partial<Omit<DraftRecord, 'id' | 'type' | 'label' | 'related' | 'agentText'>> & {
    readonly agentText?: string;
    readonly relatedIds?: readonly string[];
  },
): DraftRecord {
  const existing = state.drafts.get(id);
  const initialStep = stepOf(state, event);
  const draft: DraftRecord = existing ?? {
    id,
    seq: event.sequence,
    turnId: turnIdOf(event),
    time: event.timestamp,
    type,
    label: TRACE_TYPE_LABELS[type],
    status: 'running',
    agentText: '',
    related: new Set<string>(),
    ...(initialStep === undefined ? {} : { step: initialStep }),
  };
  if (event.sequence >= draft.seq) {
    draft.seq = event.sequence;
    draft.time = event.timestamp;
  }
  if (patch.turnId !== undefined) draft.turnId = patch.turnId;
  if (patch.step !== undefined) draft.step = patch.step;
  else if (draft.step === undefined) {
    const step = stepOf(state, event);
    if (step !== undefined) draft.step = step;
  }
  if (patch.durationMs !== undefined) draft.durationMs = patch.durationMs;
  if (patch.status !== undefined) draft.status = patch.status;
  if (patch.parameterSummary !== undefined) draft.parameterSummary = patch.parameterSummary;
  if (patch.resultSummary !== undefined) draft.resultSummary = patch.resultSummary;
  if (patch.agentText !== undefined) draft.agentText = patch.agentText;
  for (const relatedId of patch.relatedIds ?? []) draft.related.add(relatedId);
  state.drafts.set(id, draft);
  return draft;
}

function toolCallIdFrom(event: EchoEvent): string | undefined {
  switch (event.type) {
    case 'model.tool_call':
    case 'tool.requested':
      return event.payload.call.id;
    case 'approval.requested':
    case 'approval.granted':
    case 'approval.denied':
    case 'tool.authorized':
    case 'tool.started':
      return event.payload.toolCallId;
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.denied':
    case 'tool.cancelled':
      return event.payload.result.toolCallId;
    default:
      return undefined;
  }
}

function rememberTool(
  state: ProjectorState,
  toolCallId: string,
  name: string,
  input?: unknown,
): void {
  state.toolName.set(toolCallId, text(state, name, WEB_BOUNDS.toolMax));
  if (input !== undefined) {
    const cleaned = dropSensitive(input, 0, state.redaction);
    state.toolInput.set(toolCallId, cleaned);
    if (typeof cleaned === 'object' && cleaned !== null && !Array.isArray(cleaned)) {
      const command = Reflect.get(cleaned, 'command');
      if (typeof command === 'string' && command.length > 0) {
        state.toolCommand.set(toolCallId, text(state, command));
      }
    }
  }
}

function durationSince(startedAt: number | undefined, timestamp: string): number | undefined {
  if (startedAt === undefined) return undefined;
  const ended = Date.parse(timestamp);
  if (!Number.isFinite(ended) || ended < startedAt) return undefined;
  return ended - startedAt;
}

function applyEvent(state: ProjectorState, event: EchoEvent): void {
  if (event.type === 'model.reasoning') return;

  if (event.type === 'step.started' && event.stepId !== undefined) {
    state.stepNumber.set(event.stepId, event.payload.step);
  }

  switch (event.type) {
    case 'turn.started': {
      const id = traceRecordId('user', turnIdOf(event));
      state.turnStartedAt.set(turnIdOf(event), Date.parse(event.timestamp));
      upsert(state, event, 'user', id, {
        status: 'completed',
        parameterSummary: text(state, event.payload.goal),
      });
      return;
    }
    case 'context.projected': {
      const step = stepOf(state, event);
      const id = traceRecordId(
        'context',
        turnIdOf(event),
        step === undefined ? String(event.sequence) : String(step),
      );
      const used = String(event.payload.approximateTokens);
      const limit =
        event.payload.maxApproxTokens === undefined
          ? TRACE_UNAVAILABLE
          : String(event.payload.maxApproxTokens);
      upsert(state, event, 'context', id, {
        status: 'completed',
        parameterSummary: text(state, `${used} / ${limit}`),
        resultSummary: text(
          state,
          event.payload.truncationCount > 0
            ? `trimmed ${String(event.payload.truncationCount)}`
            : 'no trim',
        ),
      });
      return;
    }
    case 'model.started': {
      const step = stepOf(state, event);
      const id = traceRecordId(
        'agent',
        turnIdOf(event),
        step === undefined ? String(event.sequence) : String(step),
      );
      state.agentStartedAt.set(id, Date.parse(event.timestamp));
      upsert(state, event, 'agent', id, {
        status: 'running',
        parameterSummary: text(state, event.payload.model),
      });
      return;
    }
    case 'model.text': {
      const step = stepOf(state, event);
      const id = traceRecordId(
        'agent',
        turnIdOf(event),
        step === undefined ? String(event.sequence) : String(step),
      );
      const existing = state.drafts.get(id);
      upsert(state, event, 'agent', id, {
        status: event.payload.partial === true ? 'running' : (existing?.status ?? 'running'),
        agentText: text(state, event.payload.text, WEB_BOUNDS.bodyMax),
        resultSummary: text(state, event.payload.text),
      });
      return;
    }
    case 'model.text_delta': {
      const step = stepOf(state, event);
      const id = traceRecordId(
        'agent',
        turnIdOf(event),
        step === undefined ? String(event.sequence) : String(step),
      );
      const existing = state.drafts.get(id);
      const nextText = text(
        state,
        `${existing?.agentText ?? ''}${event.payload.delta}`,
        WEB_BOUNDS.bodyMax,
      );
      upsert(state, event, 'agent', id, {
        status: existing?.status ?? 'running',
        agentText: nextText,
        resultSummary: text(state, nextText),
      });
      return;
    }
    case 'model.completed': {
      const step = stepOf(state, event);
      const id = traceRecordId(
        'agent',
        turnIdOf(event),
        step === undefined ? String(event.sequence) : String(step),
      );
      const completedDuration = durationSince(state.agentStartedAt.get(id), event.timestamp);
      upsert(state, event, 'agent', id, {
        status: 'completed',
        resultSummary: text(state, event.payload.finishReason),
        ...(completedDuration === undefined ? {} : { durationMs: completedDuration }),
      });
      return;
    }
    case 'model.failed': {
      const step = stepOf(state, event);
      const id = traceRecordId(
        'agent',
        turnIdOf(event),
        step === undefined ? String(event.sequence) : String(step),
      );
      const failedDuration = durationSince(state.agentStartedAt.get(id), event.timestamp);
      upsert(state, event, 'agent', id, {
        status: 'failed',
        resultSummary: text(state, event.payload.error.code),
        ...(failedDuration === undefined ? {} : { durationMs: failedDuration }),
      });
      return;
    }
    case 'model.tool_call': {
      rememberTool(
        state,
        event.payload.call.id,
        event.payload.call.name,
        event.payload.call.arguments,
      );
      return;
    }
    case 'tool.requested': {
      const toolCallId = event.payload.call.id;
      rememberTool(state, toolCallId, event.payload.call.name, event.payload.normalizedInput);
      const id = traceRecordId('tool', toolCallId);
      upsert(state, event, 'tool', id, {
        status: 'running',
        parameterSummary: text(state, event.payload.call.name),
        relatedIds: [traceRecordId('policy', toolCallId)],
      });
      return;
    }
    case 'tool.started': {
      const toolCallId = event.payload.toolCallId;
      rememberTool(state, toolCallId, event.payload.toolName);
      upsert(state, event, 'tool', traceRecordId('tool', toolCallId), {
        status: 'running',
        parameterSummary: text(state, event.payload.toolName),
      });
      return;
    }
    case 'approval.requested': {
      const toolCallId = event.payload.toolCallId;
      upsert(state, event, 'approval', traceRecordId('approval', toolCallId), {
        status: 'pending',
        parameterSummary: text(state, state.toolName.get(toolCallId) ?? 'tool'),
        resultSummary: text(state, event.payload.reason),
        relatedIds: [traceRecordId('policy', toolCallId), traceRecordId('tool', toolCallId)],
      });
      upsert(state, event, 'policy', traceRecordId('policy', toolCallId), {
        status: 'ask',
        relatedIds: [traceRecordId('approval', toolCallId), traceRecordId('tool', toolCallId)],
      });
      return;
    }
    case 'approval.granted': {
      const toolCallId = event.payload.toolCallId;
      upsert(state, event, 'approval', traceRecordId('approval', toolCallId), {
        status: event.payload.scope === 'session' ? 'allowed_session' : 'allowed_once',
        resultSummary: text(state, event.payload.scope),
      });
      return;
    }
    case 'approval.denied': {
      const toolCallId = event.payload.toolCallId;
      upsert(state, event, 'approval', traceRecordId('approval', toolCallId), {
        status: event.payload.outcome === 'failed' ? 'failed' : 'denied',
        resultSummary: text(state, event.payload.reason),
      });
      return;
    }
    case 'tool.authorized': {
      const toolCallId = event.payload.toolCallId;
      upsert(state, event, 'policy', traceRecordId('policy', toolCallId), {
        status: event.payload.source === 'policy' ? 'allow' : 'ask',
        resultSummary: text(state, event.payload.reason ?? event.payload.source),
        relatedIds: [traceRecordId('tool', toolCallId)],
      });
      return;
    }
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.denied':
    case 'tool.cancelled': {
      applyToolTerminal(state, event);
      return;
    }
    case 'turn.completed':
    case 'turn.failed':
    case 'turn.cancelled': {
      const result = event.payload.result;
      const id = traceRecordId('turn', turnIdOf(event));
      const verificationId = state.lastVerification.get(turnIdOf(event));
      const turnDuration = durationSince(state.turnStartedAt.get(turnIdOf(event)), event.timestamp);
      upsert(state, event, 'turn', id, {
        status: result.status,
        parameterSummary: text(state, result.stopReason),
        resultSummary: text(
          state,
          `${String(result.steps)} steps · ${String(result.toolCalls)} tools`,
        ),
        relatedIds:
          verificationId === undefined
            ? [traceRecordId('user', turnIdOf(event))]
            : [traceRecordId('user', turnIdOf(event)), verificationId],
        ...(turnDuration === undefined ? {} : { durationMs: turnDuration }),
      });
      return;
    }
    default:
      return;
  }
}

function applyToolTerminal(
  state: ProjectorState,
  event: EchoEvent & {
    readonly type: 'tool.completed' | 'tool.failed' | 'tool.denied' | 'tool.cancelled';
  },
): void {
  const result = event.payload.result;
  const toolCallId = result.toolCallId;
  const durationMs = 'durationMs' in event.payload ? event.payload.durationMs : undefined;
  upsert(state, event, 'tool', traceRecordId('tool', toolCallId), {
    status: result.status,
    parameterSummary: text(state, result.toolName),
    resultSummary: text(state, result.summary),
    relatedIds: [traceRecordId('policy', toolCallId)],
    ...(durationMs === undefined ? {} : { durationMs }),
  });

  if (event.type === 'tool.denied') {
    upsert(state, event, 'policy', traceRecordId('policy', toolCallId), {
      status: 'deny',
      resultSummary: text(state, result.summary),
      relatedIds: [traceRecordId('tool', toolCallId)],
    });
  }

  maybeVerification(state, event, result, durationMs);
}

function maybeVerification(
  state: ProjectorState,
  event: EchoEvent,
  result: ToolResultMessage,
  durationMs: number | undefined,
): void {
  if (result.toolName !== 'run_command') return;
  const exitCode = metaNumber(result.metadata, 'exitCode');
  if (exitCode === undefined) return;
  const elapsed = metaNumber(result.metadata, 'durationMs') ?? durationMs;
  const id = traceRecordId('verification', result.toolCallId);
  const command = state.toolCommand.get(result.toolCallId);
  upsert(state, event, 'verification', id, {
    status: exitCode === 0 ? 'Verified' : `exit ${String(exitCode)}`,
    parameterSummary: command ?? TRACE_UNAVAILABLE,
    resultSummary: text(state, `exit ${String(exitCode)}`),
    relatedIds: [traceRecordId('tool', result.toolCallId), traceRecordId('turn', turnIdOf(event))],
    ...(elapsed === undefined ? {} : { durationMs: elapsed }),
  });
  state.lastVerification.set(turnIdOf(event), id);
}

function metadataSection(
  draft: DraftRecord,
  redaction: ProjectionRedaction,
): DetailSection | undefined {
  return section('metadata', '元数据', {
    fields: fieldsOf(
      field(redaction, 'Turn', draft.turnId),
      draft.step === undefined ? undefined : field(redaction, 'Step', String(draft.step)),
      field(redaction, '时间', draft.time),
      draft.durationMs === undefined
        ? undefined
        : field(redaction, '耗时', `${String(draft.durationMs)} ms`),
      field(redaction, '状态', draft.status),
      field(redaction, '类型', draft.label),
    ),
  });
}

function contextSections(
  event: EchoEvent & { readonly type: 'context.projected' },
  redaction: ProjectionRedaction,
): DetailSection[] {
  const payload = event.payload;
  const reasons = payload.truncationReasons;
  return [
    section('parameters', '参数', {
      fields: fieldsOf(
        field(
          redaction,
          '策略版本',
          payload.projectionVersion === undefined ? TRACE_UNAVAILABLE : payload.projectionVersion,
        ),
        field(redaction, '已用', String(payload.approximateTokens)),
        field(
          redaction,
          '上限',
          payload.maxApproxTokens === undefined
            ? TRACE_UNAVAILABLE
            : String(payload.maxApproxTokens),
        ),
        field(
          redaction,
          '输出预留',
          payload.reservedOutputTokens === undefined
            ? TRACE_UNAVAILABLE
            : String(payload.reservedOutputTokens),
        ),
        field(redaction, '省略事件', String(payload.omittedEventCount)),
        field(redaction, '纳入数量', TRACE_UNAVAILABLE),
        field(redaction, '角色摘要', TRACE_UNAVAILABLE),
      ),
    }),
    section('limits', '限制', {
      fields: fieldsOf(
        field(redaction, '截断次数', String(payload.truncationCount)),
        field(
          redaction,
          '裁剪原因',
          reasons === undefined || reasons.length === 0
            ? TRACE_UNAVAILABLE
            : reasons.map((reason) => fieldText(reason, WEB_BOUNDS.textMax, redaction)).join('; '),
        ),
      ),
    }),
  ].filter((item): item is DetailSection => item !== undefined);
}

function policySections(
  events: readonly EchoEvent[],
  toolCallId: string,
  redaction: ProjectionRedaction,
): DetailSection[] {
  const fact = policyExplainForToolCall(events, toolCallId);
  const decision =
    fact?.policy.availability === 'recorded' ? fact.policy.action : TRACE_UNAVAILABLE;
  const ruleId = fact?.policy.availability === 'recorded' ? fact.policy.ruleId : TRACE_UNAVAILABLE;
  const reason = fact?.policy.availability === 'recorded' ? fact.policy.reason : TRACE_UNAVAILABLE;
  const executed =
    fact === undefined
      ? TRACE_UNAVAILABLE
      : fact.execution === 'completed' ||
          fact.execution === 'running' ||
          fact.execution === 'authorized'
        ? fact.execution
        : fact.execution;
  return [
    section('result', '结果', {
      fields: fieldsOf(
        field(redaction, 'decision', decision),
        field(redaction, 'rule ID', ruleId),
        field(redaction, '原因', reason),
        field(redaction, '最终执行', executed),
        field(redaction, '审批', fact?.approval ?? TRACE_UNAVAILABLE),
      ),
    }),
  ].filter((item): item is DetailSection => item !== undefined);
}

function toolSections(
  state: ProjectorState,
  result: ToolResultMessage | undefined,
  toolCallId: string,
): DetailSection[] {
  const input = state.toolInput.get(toolCallId);
  const name = state.toolName.get(toolCallId) ?? result?.toolName;
  const redaction = state.redaction;
  const parameterFields = fieldsOf(
    field(redaction, '工具', name),
    field(redaction, '参数', summarizeUnknown(input, WEB_BOUNDS.textMax, redaction)),
  );
  const pathValue = result === undefined ? undefined : metaString(result.metadata, 'path');
  const relative =
    pathValue === undefined ? undefined : relativeWorkspacePath(pathValue, redaction);
  const diffText = result === undefined ? undefined : metaString(result.metadata, 'diff');
  const omitted =
    result === undefined ? undefined : metaNumber(result.metadata, 'omittedDiffChars');
  const diff =
    relative === undefined || diffText === undefined
      ? undefined
      : {
          path: relative,
          ...(() => {
            const bounded = bodyText(diffText, WEB_BOUNDS.bodyMax, redaction);
            return {
              text: bounded.text,
              truncated:
                bounded.truncated ||
                result?.truncated === true ||
                (omitted !== undefined && omitted > 0),
            };
          })(),
        };

  const output =
    result?.content === undefined
      ? undefined
      : {
          language: 'text',
          ...(() => {
            const bounded = bodyText(result.content, WEB_BOUNDS.bodyMax, redaction);
            return {
              text: bounded.text,
              truncated: bounded.truncated || result.truncated === true,
            };
          })(),
        };

  return [
    section('parameters', '参数', { fields: parameterFields }),
    section('result', '结果', {
      fields: fieldsOf(
        field(redaction, '状态', result?.status),
        field(redaction, '摘要', result === undefined ? undefined : result.summary),
        relative === undefined ? undefined : field(redaction, '路径', relative),
      ),
      ...(output === undefined ? {} : { code: output }),
      ...(diff === undefined ? {} : { diff }),
    }),
    section('limits', '限制', {
      fields: fieldsOf(
        result?.truncated === true || (omitted !== undefined && omitted > 0)
          ? field(redaction, '截断', 'truncated')
          : undefined,
      ),
    }),
  ].filter((item): item is DetailSection => item !== undefined);
}

function verificationSections(
  state: ProjectorState,
  draft: DraftRecord,
  result: ToolResultMessage | undefined,
): DetailSection[] {
  const exitCode = result === undefined ? undefined : metaNumber(result.metadata, 'exitCode');
  const command = state.toolCommand.get(draft.id.replace(/^verification_/u, ''));
  const truncated =
    result?.truncated === true ||
    metaBoolean(result?.metadata, 'stdoutTruncated') ||
    metaBoolean(result?.metadata, 'stderrTruncated');
  const verified = exitCode === 0;
  return [
    section('result', '结果', {
      fields: fieldsOf(
        field(state.redaction, '命令', command ?? draft.parameterSummary ?? TRACE_UNAVAILABLE),
        field(
          state.redaction,
          '退出码',
          exitCode === undefined ? TRACE_UNAVAILABLE : String(exitCode),
        ),
        draft.durationMs === undefined
          ? undefined
          : field(state.redaction, '耗时', `${String(draft.durationMs)} ms`),
        field(state.redaction, '截断', truncated ? 'truncated' : 'none'),
        field(
          state.redaction,
          '含义',
          verified ? 'Verified · 仅表示命令退出码为 0' : 'exit code is not proof of correctness',
        ),
      ),
    }),
    section('evidence', '证据', {
      fields: fieldsOf(field(state.redaction, '验证', verified ? 'Verified' : 'Not verified')),
    }),
  ].filter((item): item is DetailSection => item !== undefined);
}

function turnSections(state: ProjectorState, draft: DraftRecord): DetailSection[] {
  const verificationId = state.lastVerification.get(draft.turnId);
  return [
    section('result', '结果', {
      fields: fieldsOf(
        field(state.redaction, '终态', draft.status),
        field(state.redaction, 'stop reason', draft.parameterSummary ?? TRACE_UNAVAILABLE),
        field(state.redaction, '规模', draft.resultSummary ?? TRACE_UNAVAILABLE),
      ),
    }),
    section('evidence', '证据', {
      fields: fieldsOf(
        field(
          state.redaction,
          '最近验证',
          verificationId === undefined ? 'Not verified' : 'structured run_command',
        ),
      ),
    }),
  ].filter((item): item is DetailSection => item !== undefined);
}

function approvalSections(draft: DraftRecord, redaction: ProjectionRedaction): DetailSection[] {
  return [
    section('result', '结果', {
      fields: fieldsOf(
        field(redaction, '决定', draft.status),
        field(redaction, '说明', draft.resultSummary ?? TRACE_UNAVAILABLE),
      ),
    }),
  ].filter((item): item is DetailSection => item !== undefined);
}

function agentSections(draft: DraftRecord, redaction: ProjectionRedaction): DetailSection[] {
  const agentText = draft.agentText;
  const code =
    agentText.length === 0
      ? undefined
      : { language: 'text', ...bodyText(agentText, WEB_BOUNDS.bodyMax, redaction) };
  return [
    section('parameters', '参数', {
      fields: fieldsOf(field(redaction, '模型', draft.parameterSummary)),
    }),
    section('result', '结果', {
      fields: fieldsOf(field(redaction, '终止', draft.resultSummary)),
      ...(code === undefined ? {} : { code }),
    }),
  ].filter((item): item is DetailSection => item !== undefined);
}

function userSections(draft: DraftRecord, redaction: ProjectionRedaction): DetailSection[] {
  return [
    section('parameters', '参数', {
      fields: fieldsOf(field(redaction, '目标', draft.parameterSummary)),
    }),
  ].filter((item): item is DetailSection => item !== undefined);
}

function lastToolResult(
  events: readonly EchoEvent[],
  toolCallId: string,
): ToolResultMessage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === 'tool.completed' ||
      event?.type === 'tool.failed' ||
      event?.type === 'tool.denied' ||
      event?.type === 'tool.cancelled'
    ) {
      if (event.payload.result.toolCallId === toolCallId) return event.payload.result;
    }
  }
  return undefined;
}

function lastContextEvent(
  events: readonly EchoEvent[],
  draft: DraftRecord,
): (EchoEvent & { readonly type: 'context.projected' }) | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'context.projected') continue;
    if (turnIdOf(event) !== draft.turnId) continue;
    if (draft.step !== undefined && event.stepId !== undefined) {
      return event;
    }
    if (event.sequence === draft.seq) return event;
    return event;
  }
  return undefined;
}

function detailFor(
  state: ProjectorState,
  events: readonly EchoEvent[],
  draft: DraftRecord,
): TraceRecordDetailDto {
  const toolCallId = draft.id.replace(/^(?:tool|policy|approval|verification)_/u, '');
  const toolResult = lastToolResult(events, toolCallId);
  const sections = [
    metadataSection(draft, state.redaction),
    ...(draft.type === 'user' ? userSections(draft, state.redaction) : []),
    ...(draft.type === 'context'
      ? (() => {
          const projected = lastContextEvent(events, draft);
          return projected === undefined ? [] : contextSections(projected, state.redaction);
        })()
      : []),
    ...(draft.type === 'agent' ? agentSections(draft, state.redaction) : []),
    ...(draft.type === 'tool' ? toolSections(state, toolResult, toolCallId) : []),
    ...(draft.type === 'policy' ? policySections(events, toolCallId, state.redaction) : []),
    ...(draft.type === 'approval' ? approvalSections(draft, state.redaction) : []),
    ...(draft.type === 'verification' ? verificationSections(state, draft, toolResult) : []),
    ...(draft.type === 'turn' ? turnSections(state, draft) : []),
  ].filter((item): item is DetailSection => item !== undefined);

  const related = [...draft.related]
    .filter((id) => id !== draft.id)
    .slice(0, WEB_BOUNDS.relatedIdsMax);
  return {
    ...toRecord(draft, sections.length > 0, state.redaction),
    sections: sections.slice(0, WEB_BOUNDS.sectionsMax),
    relatedRecordIds: related,
  };
}

function toRecord(
  draft: DraftRecord,
  hasDetails: boolean,
  redaction: ProjectionRedaction,
): TraceRecordDto {
  const parameter =
    draft.parameterSummary === undefined
      ? undefined
      : boundText(draft.parameterSummary, WEB_BOUNDS.textMax);
  const result =
    draft.resultSummary === undefined
      ? undefined
      : boundText(draft.resultSummary, WEB_BOUNDS.textMax);
  return {
    id: draft.id,
    seq: draft.seq,
    turnId: draft.turnId,
    time: draft.time,
    type: draft.type,
    label: draft.label,
    status: fieldText(draft.status, WEB_BOUNDS.statusMax, redaction),
    hasDetails,
    ...(draft.step === undefined ? {} : { step: draft.step }),
    ...(draft.durationMs === undefined ? {} : { durationMs: draft.durationMs }),
    ...(parameter === undefined || parameter.text.length === 0
      ? {}
      : { parameterSummary: parameter.text }),
    ...(result === undefined || result.text.length === 0 ? {} : { resultSummary: result.text }),
  };
}

function refreshPolicies(state: ProjectorState, events: readonly EchoEvent[]): void {
  const toolCallIds = new Set<string>();
  for (const event of events) {
    const toolCallId = toolCallIdFrom(event);
    if (toolCallId !== undefined) toolCallIds.add(toolCallId);
  }
  for (const toolCallId of toolCallIds) {
    const fact = policyExplainForToolCall(events, toolCallId);
    if (fact === undefined) continue;
    const id = traceRecordId('policy', toolCallId);
    const existing = state.drafts.get(id);
    const status = fact.policy.availability === 'recorded' ? fact.policy.action : TRACE_UNAVAILABLE;
    const seed: EchoEvent | undefined = events.find(
      (event) => toolCallIdFrom(event) === toolCallId,
    );
    if (seed === undefined) continue;
    upsert(
      state,
      existing === undefined ? seed : { ...seed, sequence: existing.seq, timestamp: existing.time },
      'policy',
      id,
      {
        status,
        parameterSummary: text(state, state.toolName.get(toolCallId) ?? 'tool'),
        resultSummary:
          fact.policy.availability === 'recorded'
            ? text(state, fact.policy.ruleId)
            : TRACE_UNAVAILABLE,
        relatedIds: [
          traceRecordId('tool', toolCallId),
          ...(state.drafts.has(traceRecordId('approval', toolCallId))
            ? [traceRecordId('approval', toolCallId)]
            : []),
        ],
      },
    );
  }
}

export function projectTrace(
  events: readonly EchoEvent[],
  redaction: ProjectionRedaction = {},
): TraceProjection {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const state: ProjectorState = {
    redaction,
    drafts: new Map(),
    stepNumber: new Map(),
    toolName: new Map(),
    toolInput: new Map(),
    toolCommand: new Map(),
    lastVerification: new Map(),
    agentStartedAt: new Map(),
    turnStartedAt: new Map(),
  };
  for (const event of ordered) applyEvent(state, event);
  refreshPolicies(state, ordered);

  const details: Record<string, TraceRecordDetailDto> = {};
  const records: TraceRecordDto[] = [];
  const drafts = [...state.drafts.values()].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    return left.id.localeCompare(right.id);
  });
  for (const draft of drafts) {
    const detail = detailFor(state, ordered, draft);
    details[draft.id] = detail;
    records.push(toRecord(draft, detail.sections.length > 0, redaction));
  }
  return { records, details };
}

export function projectTraceDetail(
  events: readonly EchoEvent[],
  recordId: string,
  redaction: ProjectionRedaction = {},
): TraceRecordDetailDto | undefined {
  return projectTrace(events, redaction).details[recordId];
}
