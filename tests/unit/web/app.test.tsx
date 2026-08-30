// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import { createFakeTransport } from '../../../src/web/client/transport/fake-transport.js';

describe('Web application shell', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the two-column console without claiming Fastify or live API features', () => {
    render(<App />);

    expect(screen.getByText('ECHO')).toBeTruthy();
    expect(screen.getByRole('link', { name: '跳到主内容' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Session' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('尚无 Session。新建会话后开始对话。')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
  });

  it('creates a session from the empty rail and projects it into Chat', async () => {
    const user = userEvent.setup();
    render(<App transport={createFakeTransport()} />);

    await user.click(screen.getByRole('button', { name: '新会话' }));

    expect(screen.getByRole('heading', { name: '新会话' })).toBeTruthy();
    expect(screen.getByText('开始对话。历史只投影聚合 Session 事实。')).toBeTruthy();
    expect(screen.getByLabelText('模型')).toBeTruthy();
    expect(screen.getByLabelText('安全模式')).toBeTruthy();
    expect(screen.getByTestId('context-usage').textContent).toContain('256000');
  });

  it('keeps workspace name, model, and safety mode out of the workspace header', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport();
    render(<App transport={transport} />);
    await user.click(screen.getByRole('button', { name: '新会话' }));

    const header = screen.getByRole('banner');
    expect(within(header).queryByText('echo-harness')).toBeNull();
    expect(within(header).queryByText('echo-model')).toBeNull();
    expect(within(header).queryByText('balanced')).toBeNull();
    expect(screen.getByTestId('workspace-name').textContent).toBe('echo-harness');
    expect(screen.getByTestId('workspace-name').textContent).not.toMatch(/[/\\:]/);
  });

  it('projects Fake transport disconnect onto the header without implying Provider failure', () => {
    render(<App transport={createFakeTransport({ connection: 'disconnected' })} />);

    expect(screen.getByTestId('connection-status').textContent).toContain('未连接');
    expect(screen.getByTestId('connection-dot-disconnected')).toBeTruthy();
  });

  it('does not create a Session from the rail or transport while disconnected', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({ connection: 'disconnected' });
    render(<App transport={transport} />);

    expect(screen.getByRole('button', { name: '新会话' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Provider 不可用或本地 API 不可达')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '新会话' }));
    transport.createSession();
    expect(transport.getSnapshot().sessions).toEqual([]);
  });
});
