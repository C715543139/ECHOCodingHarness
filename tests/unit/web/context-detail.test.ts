import { describe, expect, it } from 'vitest';

import { projectTrace, TRACE_UNAVAILABLE } from '../../../src/web/trace/index.js';

import { detailOf, fieldValue, recordOf } from './trace-detail-helpers.js';
import { eightTypeEvents, legacyPolicyEvents } from './trace-fixtures.js';

describe('Context Inspector detail', () => {
  it('shows budget and trim facts without full file contents', () => {
    const { records, details } = projectTrace(eightTypeEvents());
    const detail = detailOf(
      details,
      recordOf(records, (item) => item.type === 'context'),
    );
    expect(fieldValue(detail, '已用')).toBe('1200');
    expect(fieldValue(detail, '上限')).toBe('256000');
    expect(fieldValue(detail, '输出预留')).toBe('4096');
    expect(fieldValue(detail, '策略版本')).toBe('ctx-v3');
    expect(fieldValue(detail, '裁剪原因')).toBe('old_tool_output');
    expect(JSON.stringify(detail)).not.toMatch(/列出工作区文件/u);
    expect(JSON.stringify(detail)).not.toMatch(/export const x/u);
  });

  it('marks missing context budget fields unavailable on old sessions', () => {
    const { records, details } = projectTrace(legacyPolicyEvents());
    const detail = detailOf(
      details,
      recordOf(records, (item) => item.type === 'context'),
    );
    expect(fieldValue(detail, '上限')).toBe(TRACE_UNAVAILABLE);
    expect(fieldValue(detail, '输出预留')).toBe(TRACE_UNAVAILABLE);
    expect(fieldValue(detail, '策略版本')).toBe(TRACE_UNAVAILABLE);
    expect(fieldValue(detail, '角色摘要')).toBe(TRACE_UNAVAILABLE);
  });
});
