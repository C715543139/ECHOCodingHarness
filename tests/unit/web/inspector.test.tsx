// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { TraceRecordDto } from '../../../src/contracts/web.js';
import { InspectorPane } from '../../../src/web/client/shell/inspector-pane.js';
import { TraceView } from '../../../src/web/client/shell/trace-view.js';
import { projectTrace } from '../../../src/web/trace/index.js';

import { recordOf } from './trace-detail-helpers.js';
import { eightTypeEvents } from './trace-fixtures.js';

function TraceInspectorHarness() {
  const projection = projectTrace(eightTypeEvents());
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const detail = selectedId === undefined ? undefined : projection.details[selectedId];

  return (
    <div>
      <TraceView
        onSelectRecord={setSelectedId}
        records={projection.records}
        selectedRecordId={selectedId}
      />
      {detail === undefined ? null : (
        <InspectorPane
          detail={detail}
          onClose={() => {
            setSelectedId(undefined);
          }}
        />
      )}
    </div>
  );
}

describe('Trace Inspector selection', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows only the structured detail for the selected record', async () => {
    const user = userEvent.setup();
    const { records } = projectTrace(eightTypeEvents());
    const userRecord = recordOf(records, (item) => item.type === 'user');
    const policy = recordOf(
      records,
      (item) => item.type === 'policy' && item.id.includes('call-write'),
    );

    render(<TraceInspectorHarness />);
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();

    await user.click(
      screen.getByRole('button', { name: `${userRecord.label} user ${userRecord.status}` }),
    );
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(inspector).toBeTruthy();
    expect(inspector.textContent).toMatch(/元数据/u);
    expect(inspector.textContent).toMatch(/列出工作区文件/u);
    expect(inspector.textContent).not.toMatch(/policy\.tool\.write_workspace/u);

    await user.click(
      screen.getByRole('button', { name: `${policy.label} policy ${policy.status}` }),
    );
    const next = screen.getByRole('complementary', { name: 'Inspector' });
    expect(next.textContent).toMatch(/policy\.tool\.write_workspace/u);
    expect(next.textContent).not.toMatch(/列出工作区文件/u);
    expect(screen.queryByRole('button', { name: /JSONL|reasoning/iu })).toBeNull();
  });

  it('virtualizes large lists and keeps the first visible row stable after tail upserts', async () => {
    const user = userEvent.setup();
    const records = Array.from({ length: 180 }, (_, index) => {
      const seq = index + 1;
      return {
        id: `rec_${String(seq)}`,
        seq,
        turnId: 'turn-1',
        time: '2026-08-30T09:00:00.000Z',
        type: 'user' as const,
        label: '用户',
        status: 'completed',
        hasDetails: false,
        parameterSummary: `goal ${String(seq)}`,
      };
    });

    function LargeList() {
      const [items, setItems] = useState(records.slice(0, 120));
      return (
        <div>
          <button
            onClick={() => {
              setItems(records);
            }}
            type="button"
          >
            append-tail
          </button>
          <TraceView
            onSelectRecord={() => undefined}
            pageSize={100}
            records={items}
            selectedRecordId={undefined}
          />
        </div>
      );
    }

    render(<LargeList />);
    const initialButtons = screen.getAllByRole('button', { name: /用户 user completed/u });
    expect(initialButtons.length).toBeLessThan(120);

    const viewport = screen.getByRole('list');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 480 },
      scrollHeight: { configurable: true, value: 7200 },
    });
    viewport.scrollTop = 5760;
    fireEvent.scroll(viewport);
    const firstLabel = screen.getAllByRole('button', { name: /用户 user completed/u })[0]
      ?.textContent;

    await user.click(screen.getByRole('button', { name: 'append-tail' }));
    const toast = screen.getByRole('button', { name: '回到最新' });
    expect(toast.parentElement?.className).toContain('toastLayer');
    expect(toast.compareDocumentPosition(viewport)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    const after = screen.getAllByRole('button', { name: /用户 user completed/u });
    expect(after[0]?.textContent).toBe(firstLabel);
    expect(after.length).toBeLessThan(180);
  });

  it('resets a scrolled large list when switching to a disjoint small list', async () => {
    const user = userEvent.setup();
    const large = Array.from({ length: 80 }, (_, index) => ({
      id: `big_${String(index + 1)}`,
      seq: index + 1,
      turnId: 'turn-big',
      time: '2026-08-30T09:00:00.000Z',
      type: 'user' as const,
      label: '用户',
      status: 'completed',
      hasDetails: false,
      parameterSummary: `big ${String(index + 1)}`,
    }));
    const small = [
      {
        id: 'small_a',
        seq: 1,
        turnId: 'turn-small',
        time: '2026-08-30T10:00:00.000Z',
        type: 'user' as const,
        label: '用户',
        status: 'completed',
        hasDetails: false,
        parameterSummary: 'alpha',
      },
      {
        id: 'small_b',
        seq: 2,
        turnId: 'turn-small',
        time: '2026-08-30T10:00:01.000Z',
        type: 'context' as const,
        label: '上下文',
        status: 'completed',
        hasDetails: true,
        parameterSummary: 'budget',
      },
    ];

    function SwitchList() {
      const [items, setItems] = useState<readonly TraceRecordDto[]>(large);
      return (
        <div>
          <button
            onClick={() => {
              setItems(small);
            }}
            type="button"
          >
            switch-small
          </button>
          <TraceView
            onSelectRecord={() => undefined}
            pageSize={100}
            records={items}
            selectedRecordId={undefined}
          />
        </div>
      );
    }

    render(<SwitchList />);
    const viewport = screen.getByRole('list');
    viewport.scrollTop = 2400;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    await user.click(screen.getByRole('button', { name: 'switch-small' }));

    expect(viewport.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: '用户 user completed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '上下文 context completed' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps virtual rows from overlapping when summaries are long', () => {
    const records = Array.from({ length: 50 }, (_, index) => ({
      id: `long_${String(index + 1)}`,
      seq: index + 1,
      turnId: 'turn-1',
      time: '2026-08-30T09:00:00.000Z',
      type: 'agent' as const,
      label: '代理',
      status: 'completed',
      hasDetails: true,
      parameterSummary: `long-summary-${'X'.repeat(240)}-${String(index + 1)}`,
      resultSummary: `result-${'Y'.repeat(240)}-${String(index + 1)}`,
    }));

    render(
      <TraceView
        onSelectRecord={() => undefined}
        pageSize={100}
        records={records}
        selectedRecordId="long_49"
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(1);
    const first = rows[0]?.getBoundingClientRect();
    const second = rows[1]?.getBoundingClientRect();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(first.height).toBeLessThanOrEqual(72);
    expect(second.top).toBeGreaterThanOrEqual(first.bottom - 0.5);
    const selected = document.querySelector('[aria-current="true"]');
    expect(selected?.getAttribute('aria-label')).toBe('代理 agent completed');
    expect(selected?.textContent).toContain('long-summary-');
  });

  it('renders decorative trace columns and keeps every row cell text-first', () => {
    render(
      <TraceView
        onSelectRecord={() => undefined}
        pageSize={100}
        records={[
          {
            id: 'rec_1',
            seq: 1,
            turnId: 'turn-1',
            time: '2026-08-30T09:12:34.000Z',
            type: 'tool',
            label: 'run_command',
            status: 'completed',
            hasDetails: true,
            durationMs: 120,
            parameterSummary: 'pnpm test',
            resultSummary: 'exit 0',
          },
        ]}
        selectedRecordId={undefined}
      />,
    );

    const columns = screen.getByText('时间').parentElement;
    expect(columns?.getAttribute('aria-hidden')).toBe('true');
    expect(columns?.textContent).toBe('时间事件状态');

    const row = screen.getByRole('button', { name: 'run_command tool completed' });
    expect(row.textContent).toContain('09:12:34');
    expect(row.textContent).toContain('completed · 120 ms');
    expect(row.textContent).toContain('pnpm test · exit 0');
    expect(screen.queryByRole('img')).toBeNull();
  });
});
