import { WEB_BOUNDS, type TraceRecordDto } from '../../contracts/web.js';

export const TRACE_PAGE_DEFAULT = 100;

export interface TracePage {
  readonly items: readonly TraceRecordDto[];
  readonly nextSeq?: number;
}

export interface TraceListState {
  readonly records: readonly TraceRecordDto[];
  readonly followTail: boolean;
  readonly anchorSeq: number | undefined;
  readonly unseenCount: number;
  readonly pageSize: number;
}

function clampLimit(limit: number): number {
  if (!Number.isSafeInteger(limit)) return TRACE_PAGE_DEFAULT;
  return Math.min(WEB_BOUNDS.tracePageMax, Math.max(1, limit));
}

export function mergeTraceRecords(
  current: readonly TraceRecordDto[],
  incoming: readonly TraceRecordDto[],
): readonly TraceRecordDto[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) {
    const existing = byId.get(record.id);
    if (existing === undefined || record.seq > existing.seq) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    return left.id.localeCompare(right.id);
  });
}

export function pageTraceRecords(
  records: readonly TraceRecordDto[],
  options: { readonly afterSeq?: number; readonly limit?: number } = {},
): TracePage {
  const limit = clampLimit(options.limit ?? TRACE_PAGE_DEFAULT);
  const afterSeq = options.afterSeq ?? -1;
  const following = records.filter((record) => record.seq > afterSeq);
  const items = following.slice(0, limit);
  const last = items.at(-1);
  const next = following.at(limit);
  return {
    items,
    ...(last === undefined || next === undefined ? {} : { nextSeq: last.seq }),
  };
}

export function createTraceListState(pageSize = TRACE_PAGE_DEFAULT): TraceListState {
  return {
    records: [],
    followTail: true,
    anchorSeq: undefined,
    unseenCount: 0,
    pageSize: clampLimit(pageSize),
  };
}

export function visibleTraceRecords(state: TraceListState): readonly TraceRecordDto[] {
  if (state.records.length === 0) return [];
  const anchorSeq = state.anchorSeq;
  if (state.followTail || anchorSeq === undefined) {
    return state.records.slice(Math.max(0, state.records.length - state.pageSize));
  }
  const start = state.records.findIndex((record) => record.seq >= anchorSeq);
  const index = start === -1 ? 0 : start;
  return state.records.slice(index, index + state.pageSize);
}

export function applyTraceUpserts(
  state: TraceListState,
  incoming: readonly TraceRecordDto[],
): TraceListState {
  const previousVisible = visibleTraceRecords(state);
  const lastVisibleSeq = previousVisible.at(-1)?.seq;
  const records = mergeTraceRecords(state.records, incoming);
  if (state.followTail) {
    return { ...state, records, unseenCount: 0, anchorSeq: undefined };
  }

  const visibleIds = new Set(previousVisible.map((record) => record.id));
  let unseen = state.unseenCount;
  for (const record of incoming) {
    const previous = state.records.find((item) => item.id === record.id);
    const isNew = previous === undefined;
    const advanced = previous !== undefined && record.seq > previous.seq;
    if (!isNew && !advanced) continue;
    if (visibleIds.has(record.id)) continue;
    if (lastVisibleSeq !== undefined && record.seq > lastVisibleSeq) unseen += 1;
  }

  return {
    ...state,
    records,
    unseenCount: unseen,
    anchorSeq: state.anchorSeq ?? previousVisible[0]?.seq,
  };
}

export function pauseTraceFollow(state: TraceListState): TraceListState {
  const visible = visibleTraceRecords(state);
  return {
    ...state,
    followTail: false,
    anchorSeq: visible[0]?.seq,
  };
}

export function resumeTraceFollow(state: TraceListState): TraceListState {
  return { ...state, followTail: true, anchorSeq: undefined, unseenCount: 0 };
}

export function loadOlderTracePage(state: TraceListState): TraceListState {
  const visible = visibleTraceRecords(state);
  const first = visible[0];
  if (first === undefined) return pauseTraceFollow(state);
  const index = state.records.findIndex((record) => record.id === first.id);
  const start = Math.max(0, index - state.pageSize);
  return {
    ...state,
    followTail: false,
    unseenCount: state.unseenCount,
    anchorSeq: state.records[start]?.seq,
  };
}
