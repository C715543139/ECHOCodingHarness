import { describe, expect, it } from 'vitest';

import { WEB_BOUNDS } from '../../../src/contracts/web.js';
import { projectTrace } from '../../../src/web/trace/index.js';

import {
  eightTypeEvents,
  resetTraceFixtureSequence,
  toolResult,
  traceEvent,
} from './trace-fixtures.js';

describe('File change diff detail', () => {
  it('shows only a relative path and a bounded diff', () => {
    const { records, details } = projectTrace(eightTypeEvents());
    const tool = records.find((item) => item.type === 'tool' && item.id.includes('call-write'));
    const detail = tool === undefined ? undefined : details[tool.id];
    const diff = detail?.sections.find((section) => section.diff !== undefined)?.diff;
    expect(diff?.path).toBe('src/a.ts');
    expect(diff?.text).toContain('export const x = 1');
    expect(diff?.truncated).toBe(false);
    expect(JSON.stringify(detail)).not.toMatch(/C:\\/u);
    expect(JSON.stringify(detail)).not.toMatch(/\/home\//u);
  });

  it('drops absolute paths and marks oversize diffs truncated', () => {
    resetTraceFixtureSequence();
    const huge = `${'A'.repeat(WEB_BOUNDS.bodyMax + 40)}\n`;
    const { records, details } = projectTrace([
      traceEvent('turn.started', { goal: 'patch' }),
      traceEvent('tool.requested', {
        call: { id: 'call-abs', name: 'write_file', arguments: { path: 'src/a.ts' } },
        normalizedInput: { path: 'src/a.ts' },
      }),
      traceEvent('tool.completed', {
        durationMs: 5,
        result: toolResult('completed', {
          toolCallId: 'call-abs',
          toolName: 'write_file',
          summary: 'updated',
          metadata: {
            path: 'C:\\Users\\leak\\repo\\src\\a.ts',
            diff: huge,
            omittedDiffChars: 12,
          },
        }),
      }),
    ]);
    const tool = records.find((item) => item.type === 'tool' && item.id.includes('call-abs'));
    const detail = tool === undefined ? undefined : details[tool.id];
    expect(detail?.sections.some((section) => section.diff !== undefined)).toBe(false);
    expect(JSON.stringify(detail)).not.toMatch(/C:\\Users\\/u);
  });

  it('keeps a relative path when the bounded diff is truncated', () => {
    resetTraceFixtureSequence();
    const huge = `+${'B'.repeat(WEB_BOUNDS.bodyMax + 8)}`;
    const { details, records } = projectTrace([
      traceEvent('turn.started', { goal: 'patch' }),
      traceEvent('tool.requested', {
        call: { id: 'call-big', name: 'apply_patch', arguments: { path: 'docs/a.md' } },
        normalizedInput: { path: 'docs/a.md' },
      }),
      traceEvent('tool.completed', {
        durationMs: 6,
        result: toolResult('completed', {
          toolCallId: 'call-big',
          toolName: 'apply_patch',
          summary: 'patched',
          truncated: true,
          metadata: { path: 'docs/a.md', diff: huge, omittedDiffChars: 80 },
        }),
      }),
    ]);
    const tool = records.find((item) => item.type === 'tool' && item.id.includes('call-big'));
    const diff = details[tool?.id ?? '']?.sections.find(
      (section) => section.diff !== undefined,
    )?.diff;
    expect(diff?.path).toBe('docs/a.md');
    expect(diff?.truncated).toBe(true);
    expect(diff?.text.length).toBeLessThanOrEqual(WEB_BOUNDS.bodyMax);
  });
});
