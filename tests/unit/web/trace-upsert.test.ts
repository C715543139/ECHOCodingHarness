import { describe, expect, it } from 'vitest';

import type { TraceRecordDto } from '../../../src/contracts/web.js';
import {
  applyTraceUpserts,
  createTraceListState,
  mergeTraceRecords,
  pageTraceRecords,
  pauseTraceFollow,
  resumeTraceFollow,
  visibleTraceRecords,
} from '../../../src/web/trace/index.js';

function record(overrides: Partial<TraceRecordDto> = {}): TraceRecordDto {
  return {
    id: 'rec_user_1',
    seq: 1,
    turnId: 'turn-1',
    time: '2026-08-30T09:00:01.000Z',
    type: 'user',
    label: '用户',
    status: 'completed',
    hasDetails: true,
    ...overrides,
  };
}

describe('Trace seq upsert', () => {
  it('ignores duplicate or older seq and accepts out-of-order newer updates', () => {
    const first = record({
      id: 'rec_agent_1',
      type: 'agent',
      label: '代理',
      seq: 4,
      status: 'running',
    });
    const stale = record({
      id: 'rec_agent_1',
      type: 'agent',
      label: '代理',
      seq: 3,
      status: 'stale',
    });
    const later = record({
      id: 'rec_agent_1',
      type: 'agent',
      label: '代理',
      seq: 8,
      status: 'completed',
    });
    const other = record({ id: 'rec_user_1', seq: 1 });

    const merged = mergeTraceRecords([], [later, other, first, stale, first]);
    expect(merged.map((item) => `${item.id}:${String(item.seq)}:${item.status}`)).toEqual([
      'rec_user_1:1:completed',
      'rec_agent_1:8:completed',
    ]);
  });

  it('pages by seq without reordering earlier records', () => {
    const records = [1, 2, 3, 4, 5].map((seq) =>
      record({ id: `rec_${String(seq)}`, seq, turnId: 'turn-1' }),
    );
    const page = pageTraceRecords(records, { afterSeq: 2, limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual(['rec_3', 'rec_4']);
    expect(page.nextSeq).toBe(4);
  });

  it('keeps the paused window stable while newer tail upserts accumulate', () => {
    const initial = Array.from({ length: 8 }, (_, index) =>
      record({ id: `rec_${String(index + 1)}`, seq: index + 1 }),
    );
    let state = applyTraceUpserts(createTraceListState(4), initial);
    expect(visibleTraceRecords(state).map((item) => item.id)).toEqual([
      'rec_5',
      'rec_6',
      'rec_7',
      'rec_8',
    ]);

    state = pauseTraceFollow(state);
    const firstVisible = visibleTraceRecords(state)[0]?.id;
    state = applyTraceUpserts(state, [
      record({ id: 'rec_9', seq: 9 }),
      record({ id: 'rec_10', seq: 10 }),
      record({ id: 'rec_3', seq: 3, status: 'completed' }),
    ]);
    expect(visibleTraceRecords(state)[0]?.id).toBe(firstVisible);
    expect(visibleTraceRecords(state).map((item) => item.id)).toEqual([
      'rec_5',
      'rec_6',
      'rec_7',
      'rec_8',
    ]);
    expect(state.unseenCount).toBe(2);

    state = resumeTraceFollow(state);
    expect(state.unseenCount).toBe(0);
    expect(visibleTraceRecords(state).map((item) => item.id)).toEqual([
      'rec_7',
      'rec_8',
      'rec_9',
      'rec_10',
    ]);
  });
});
