import { describe, expect, it } from 'vitest';

import { projectTrace, TRACE_UNAVAILABLE } from '../../../src/web/trace/index.js';

import { detailOf, fieldValue, recordOf } from './trace-detail-helpers.js';
import { eightTypeEvents, legacyPolicyEvents } from './trace-fixtures.js';

describe('Policy Inspector detail', () => {
  it('consumes structured decision and rule facts without parsing command text', () => {
    const { records, details } = projectTrace(eightTypeEvents());
    const detail = detailOf(
      details,
      recordOf(records, (item) => item.type === 'policy' && item.id.includes('call-write')),
    );
    expect(fieldValue(detail, 'decision')).toBe('ask');
    expect(fieldValue(detail, 'rule ID')).toBe('policy.tool.write_workspace');
    expect(fieldValue(detail, '审批')).toBe('allowed_once');
    expect(JSON.stringify(detail)).not.toMatch(/pnpm test/u);
  });

  it('marks legacy sessions without rule IDs unavailable', () => {
    const { records, details } = projectTrace(legacyPolicyEvents());
    const policy = recordOf(records, (item) => item.type === 'policy');
    const detail = detailOf(details, policy);
    expect(policy.status).toBe(TRACE_UNAVAILABLE);
    expect(fieldValue(detail, 'decision')).toBe(TRACE_UNAVAILABLE);
    expect(fieldValue(detail, 'rule ID')).toBe(TRACE_UNAVAILABLE);
    expect(fieldValue(detail, '原因')).toBe(TRACE_UNAVAILABLE);
  });
});
