// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import {
  createFakeTransport,
  createIdleSession,
  createRunningSession,
  createSessionRuntime,
} from '../../../src/web/client/transport/fake-transport.js';

describe('Composer shell', () => {
  afterEach(() => {
    cleanup();
  });

  it('projects injected SessionRuntimeDto context without estimating in the UI', () => {
    const idle = createIdleSession();
    const transport = createFakeTransport({
      sessions: [idle],
      selectedSessionId: idle.id,
      runtimes: {
        [idle.id]: createSessionRuntime(idle, {
          usedApproxTokens: 7,
          limitApproxTokens: 900,
        }),
      },
    });
    render(<App transport={transport} />);

    expect(screen.getByTestId('context-usage').textContent).toBe('7 / 900');
  });

  it('places model, safety mode, and context usage in the input area', () => {
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
    });
    render(<App transport={transport} />);

    expect(screen.getByLabelText('模型')).toBeTruthy();
    expect(screen.getByLabelText('安全模式')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '安全模式' })).toHaveProperty('value', 'balanced');
    expect(screen.getByTestId('context-usage').textContent).toBe('0 / 256000');
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });

  it('sends with Enter and inserts a newline with Shift+Enter', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
    });
    render(<App transport={transport} />);
    const input = screen.getByLabelText('输入');

    await user.type(input, 'hello');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(input, 'world');
    expect(transport.getSnapshot().composerText).toContain('\n');

    await user.keyboard('{Enter}');
    expect(screen.getByText(/hello/)).toBeTruthy();
    expect(screen.getByText('Fake Provider 已接受该 Turn。')).toBeTruthy();
  });

  it('disables send on a browsing session while another Turn is running', () => {
    const transport = createFakeTransport({
      sessions: [createRunningSession(), createIdleSession()],
      selectedSessionId: 'ses_idle',
    });
    render(<App transport={transport} />);

    expect(screen.getByText('另一会话正在运行')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });

  it('shows stop only on the active Session', () => {
    const transport = createFakeTransport({
      sessions: [createRunningSession()],
      selectedSessionId: 'ses_running',
    });
    render(<App transport={transport} />);

    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toHaveProperty('disabled', true);
  });
});
