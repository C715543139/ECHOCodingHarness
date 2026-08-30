// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import { SessionRail } from '../../../src/web/client/shell/session-rail.js';
import {
  createFakeTransport,
  createIdleSession,
  createRunningSession,
  createSampleChatTurn,
} from '../../../src/web/client/transport/fake-transport.js';
import { RailHarness } from './web-console-harness.js';

describe('Session rail', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders text-only session status without status icons', () => {
    render(
      <SessionRail
        canCreateSession
        createBlockedReason={undefined}
        onCreateSession={() => undefined}
        onOpenSettings={() => undefined}
        onSelectSession={() => undefined}
        selectedSessionId="ses_running"
        sessions={[createRunningSession(), createIdleSession()]}
        workspace={{ name: 'echo-harness', fingerprint: 'fp_local_fixture' }}
      />,
    );

    expect(screen.getByText(/ · Running · /)).toBeTruthy();
    expect(screen.getByText(/ · Idle · /)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTitle('Active coding session')).toBeTruthy();
  });

  it('creates a session from the primary rail action', async () => {
    const user = userEvent.setup();
    let created = false;
    render(
      <SessionRail
        canCreateSession
        createBlockedReason={undefined}
        onCreateSession={() => {
          created = true;
        }}
        onOpenSettings={() => undefined}
        onSelectSession={() => undefined}
        selectedSessionId={undefined}
        sessions={[]}
        workspace={{ name: 'echo-harness', fingerprint: 'fp_local_fixture' }}
      />,
    );

    await user.click(screen.getByRole('button', { name: '新会话' }));
    expect(created).toBe(true);
  });

  it('disables 新会话 and explains why when creation is blocked', () => {
    render(
      <SessionRail
        canCreateSession={false}
        createBlockedReason="provider_unavailable"
        onCreateSession={() => {
          throw new Error('createSession must not run when blocked');
        }}
        onOpenSettings={() => undefined}
        onSelectSession={() => undefined}
        selectedSessionId={undefined}
        sessions={[]}
        workspace={{ name: 'echo-harness', fingerprint: 'fp_local_fixture' }}
      />,
    );

    expect(screen.getByRole('button', { name: '新会话' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Provider 不可用或本地 API 不可达')).toBeTruthy();
  });

  it('collapses and expands the rail through a named toggle', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
    });
    render(<App transport={transport} />);

    const collapse = screen.getByRole('button', { name: '收起会话栏' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');

    await user.click(collapse);
    expect(screen.queryByRole('button', { name: '新会话' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Session' })).toBeTruthy();

    const expand = screen.getByRole('button', { name: '展开会话栏' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    await user.click(expand);
    expect(screen.getByRole('button', { name: '新会话' })).toBeTruthy();
  });
});

describe('Session rail paging through Fake transport', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the first page and loads more sessions on demand', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessionPageSize: 2,
      sessions: [
        createIdleSession({ id: 'ses_a', shortId: 'aaaaaa', title: 'Alpha session' }),
        createIdleSession({ id: 'ses_b', shortId: 'bbbbbb', title: 'Beta session' }),
        createIdleSession({ id: 'ses_c', shortId: 'cccccc', title: 'Gamma session' }),
      ],
      selectedSessionId: 'ses_a',
    });
    render(<RailHarness transport={transport} />);

    expect(screen.getByTitle('Alpha session')).toBeTruthy();
    expect(screen.getByTitle('Beta session')).toBeTruthy();
    expect(screen.queryByTitle('Gamma session')).toBeNull();

    await user.click(screen.getByRole('button', { name: '加载更多' }));
    expect(screen.getByTitle('Gamma session')).toBeTruthy();
  });

  it('restores another session chat without sharing the active transcript', async () => {
    const user = userEvent.setup();
    const idle = createIdleSession();
    const other = createIdleSession({
      id: 'ses_other',
      shortId: 'other1',
      title: 'Other session',
    });
    const transport = createFakeTransport({
      sessions: [idle, other],
      selectedSessionId: idle.id,
      chatTurnsBySession: {
        [idle.id]: [createSampleChatTurn({ userText: 'idle goal', status: 'completed' })],
        [other.id]: [createSampleChatTurn({ turnId: 'turn_other', userText: 'other goal' })],
      },
    });
    render(<App transport={transport} />);

    expect(screen.getByText('idle goal')).toBeTruthy();
    await user.click(screen.getByTitle('Other session'));
    expect(screen.getByText('other goal')).toBeTruthy();
    expect(screen.queryByText('idle goal')).toBeNull();
  });
});
