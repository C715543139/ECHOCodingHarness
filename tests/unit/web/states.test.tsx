// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import {
  createFakeTransport,
  createIdleSession,
  createRunningSession,
  createSampleInspectorDetail,
  createSampleTraceRecord,
} from '../../../src/web/client/transport/fake-transport.js';
import { ChatHarness } from './web-console-harness.js';

describe('Console state projection', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not keep Inspector open when no Trace record is selected', () => {
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
      view: 'trace',
      traceRecords: [createSampleTraceRecord()],
    });
    render(<App transport={transport} />);

    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
  });

  it('opens Inspector from a Trace record and closes it with Escape', async () => {
    const user = userEvent.setup();
    const record = createSampleTraceRecord();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
      view: 'trace',
      traceRecords: [record],
      inspectorDetails: { [record.id]: createSampleInspectorDetail(record) },
    });
    render(<App transport={transport} />);

    await user.click(screen.getByRole('button', { name: /用户 user/ }));
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    expect(screen.getByText('元数据')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
  });

  it('does not project a running phase and a terminal phase onto the same session row', () => {
    const transport = createFakeTransport({
      sessions: [createRunningSession({ phase: 'completed' })],
      selectedSessionId: 'ses_running',
    });
    render(<App transport={transport} />);

    expect(screen.getByText(/Completed/)).toBeTruthy();
    expect(screen.queryByText(/Running/)).toBeNull();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });

  it('shows loading, resync, failed, and cancelled Chat states as text', async () => {
    const user = userEvent.setup();
    const failed = createIdleSession({
      id: 'ses_failed',
      phase: 'failed',
      title: 'Failed session',
    });
    const transport = createFakeTransport({
      sessions: [failed],
      selectedSessionId: failed.id,
      loadingHistory: true,
      resyncRequired: true,
      chatTurns: [
        {
          turnId: 'turn_fail',
          startedAt: '2026-08-30T09:01:00.000Z',
          userText: 'broken goal',
          responses: [{ step: 1, text: 'Provider 请求失败。', partial: false }],
          toolSummaries: [],
          status: 'failed',
          stopReason: 'provider_error',
        },
      ],
    });
    render(<ChatHarness transport={transport} />);

    expect(screen.getByText('正在加载历史…')).toBeTruthy();
    expect(screen.getByTestId('resync-banner').textContent).toContain('需要完整同步');
    expect(screen.getByText(/failed · provider_error/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重新同步' }));
    expect(screen.queryByTestId('resync-banner')).toBeNull();
    expect(transport.getSnapshot().connection).toBe('connected');
  });
});
