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
});
