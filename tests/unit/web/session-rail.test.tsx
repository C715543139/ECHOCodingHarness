// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(screen.getByText('当前工作区')).toBeTruthy();
    const workspaceName = screen.getByTestId('workspace-name');
    expect(workspaceName.textContent).toBe('echo-harness');
    expect(workspaceName.parentElement?.parentElement?.querySelector('svg')).toBeNull();
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
    expect(screen.getByRole('button', { name: '设置' }).parentElement?.className).toContain(
      'railFooter',
    );
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

  it('resizes the expanded rail by pointer or keyboard within bounded widths', async () => {
    const user = userEvent.setup();
    render(<App transport={createFakeTransport()} />);

    const separator = screen.getByRole('separator', { name: '调整会话栏宽度' });
    const shell = separator.closest('nav')?.parentElement;
    expect(shell?.style.getPropertyValue('--echo-rail-width')).toBe('280px');
    expect(separator.getAttribute('aria-valuemin')).toBe('208');
    expect(separator.getAttribute('aria-valuemax')).toBe('420');

    separator.focus();
    await user.keyboard('{ArrowRight}{End}');
    expect(separator.getAttribute('aria-valuenow')).toBe('420');
    expect(shell?.style.getPropertyValue('--echo-rail-width')).toBe('420px');

    Object.defineProperty(separator, 'setPointerCapture', {
      configurable: true,
      value: () => undefined,
    });
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 180, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(separator.getAttribute('aria-valuenow')).toBe('208');

    await user.dblClick(separator);
    expect(separator.getAttribute('aria-valuenow')).toBe('280');
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

  it('requires confirmation before deleting an idle session', async () => {
    const user = userEvent.setup();
    const idle = createIdleSession();
    const other = createIdleSession({ id: 'ses_other', title: 'Keep this session' });
    const transport = createFakeTransport({ sessions: [idle, other], selectedSessionId: idle.id });
    render(<App transport={transport} />);

    await user.click(screen.getByRole('button', { name: `删除会话 ${idle.title}` }));
    const dialog = screen.getByRole('dialog', { name: '删除会话？' });
    expect(within(dialog).getByText('删除后将永久移除该会话记录，无法恢复。')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.getByTitle(idle.title)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: `删除会话 ${idle.title}` }));
    await user.click(screen.getByRole('button', { name: /^删除会话$/u }));
    expect(screen.queryByTitle(idle.title)).toBeNull();
    expect(screen.getByRole('heading', { name: other.title })).toBeTruthy();
  });

  it('explains that deleting the running session stops its Turn first', async () => {
    const user = userEvent.setup();
    const running = createRunningSession();
    const other = createIdleSession({ id: 'ses_other', title: 'Other session' });
    const transport = createFakeTransport({
      sessions: [running, other],
      selectedSessionId: running.id,
    });
    render(<App transport={transport} />);

    await user.click(screen.getByRole('button', { name: `删除会话 ${running.title}` }));
    expect(
      screen.getByText('当前会话仍在运行。确认后将先停止当前 Turn，等待结束，再永久删除会话。'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '停止并删除' }));

    expect(screen.queryByTitle(running.title)).toBeNull();
    expect(transport.getSnapshot().bootstrap.capabilities.activeSessionId).toBeUndefined();
  });

  it('keeps the session and confirmation open when deletion fails', async () => {
    const user = userEvent.setup();
    const idle = createIdleSession();
    const base = createFakeTransport({ sessions: [idle], selectedSessionId: idle.id });
    const transport = {
      ...base,
      deleteSession: async (): Promise<void> => {
        throw new Error('会话文件暂时无法删除。');
      },
    };
    render(<App transport={transport} />);

    await user.click(screen.getByRole('button', { name: `删除会话 ${idle.title}` }));
    await user.click(screen.getByRole('button', { name: /^删除会话$/u }));

    expect(await screen.findByText('会话文件暂时无法删除。')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '删除会话？' })).toBeTruthy();
    expect(screen.getByTitle(idle.title)).toBeTruthy();
  });
});
