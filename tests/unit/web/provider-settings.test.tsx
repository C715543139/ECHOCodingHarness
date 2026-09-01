// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import {
  createFakeTransport,
  createIdleSession,
  createRunningSession,
} from '../../../src/web/client/transport/fake-transport.js';
import { SettingsHarness } from './web-console-harness.js';

describe('Provider settings modal', () => {
  afterEach(() => {
    cleanup();
  });

  it('registers only the Provider page and never mounts an API key field', async () => {
    const user = userEvent.setup();
    render(
      <App
        transport={createFakeTransport({
          sessions: [createIdleSession()],
          selectedSessionId: 'ses_idle',
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '设置' }));

    expect(screen.getByRole('dialog', { name: 'Provider' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '设置' }).textContent).toContain('Provider');
    expect(screen.getByText('已通过环境变量配置')).toBeTruthy();
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(screen.queryByDisplayValue(/sk-|api[_-]?key/i)).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('moves focus into the dialog and restores it to 设置 after Escape', async () => {
    const user = userEvent.setup();
    render(
      <App
        transport={createFakeTransport({
          sessions: [createIdleSession()],
          selectedSessionId: 'ses_idle',
        })}
      />,
    );
    const settingsButton = screen.getByRole('button', { name: '设置' });
    settingsButton.focus();
    await user.click(settingsButton);

    expect(screen.getByRole('heading', { name: 'Provider' })).toBe(document.activeElement);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '设置' })).toBe(document.activeElement);
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(
      <App
        transport={createFakeTransport({
          sessions: [createIdleSession()],
          selectedSessionId: 'ses_idle',
        })}
      />,
    );
    const settingsButton = screen.getByRole('button', { name: '设置' });
    settingsButton.focus();
    await user.click(settingsButton);

    expect(screen.getByRole('heading', { name: 'Provider' })).toBe(document.activeElement);

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '保存' })).toBe(document.activeElement);
    expect(screen.getByRole('button', { name: '新会话' })).not.toBe(document.activeElement);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Provider' })).toBe(document.activeElement);
    await user.tab();
    expect(screen.getByRole('button', { name: '扩展' })).toBe(document.activeElement);
    await user.tab();
    expect(screen.getByLabelText('Base URL')).toBe(document.activeElement);
    expect(
      screen.getByRole('navigation', { name: 'Session' }).contains(document.activeElement),
    ).toBe(false);
  });

  it('closes the modal with Escape without cancelling an active Turn', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createRunningSession()],
      selectedSessionId: 'ses_running',
    });
    render(<App transport={transport} />);
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(transport.getSnapshot().sessions[0]?.phase).toBe('running');
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
  });

  it('makes Provider fields read-only while a Turn is running', async () => {
    const user = userEvent.setup();
    render(
      <App
        transport={createFakeTransport({
          sessions: [createRunningSession()],
          selectedSessionId: 'ses_running',
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.getByText('活动 Turn 存在时设置只读。')).toBeTruthy();
    expect(screen.getByLabelText('Base URL')).toHaveProperty('readOnly', true);
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '获取模型' })).toHaveProperty('disabled', true);
  });

  it('discovers models without saving and never mounts an API key value', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
    });
    render(<SettingsHarness transport={transport} />);
    await user.click(screen.getByRole('button', { name: '获取模型' }));

    expect(screen.getByRole('list', { name: '发现的模型' }).textContent).toContain('echo-fast');
    expect(screen.getByText('发现结果只读，不会自动保存。')).toBeTruthy();
    expect(transport.getSnapshot().lastDiscoveredAt).toBe('2026-08-30T11:00:00.000Z');
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(transport.getSnapshot().bootstrap.provider.catalog).toEqual({
      source: 'discover',
      cachedModels: ['echo-model'],
    });
    expect(document.body.innerHTML).not.toMatch(/sk-[A-Za-z0-9]|ECHO_API_KEY|apiKey=/i);
  });

  it('validates Provider fields near the control and keeps the modal open', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
    });
    render(<SettingsHarness transport={transport} />);
    await user.clear(screen.getByLabelText('Base URL'));
    await user.type(screen.getByLabelText('Base URL'), 'not-a-url');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByRole('dialog', { name: 'Provider' })).toBeTruthy();
    expect(screen.getByText('请修正 Provider 设置中的错误。')).toBeTruthy();
    expect(screen.getByText('Base URL 无效')).toBeTruthy();
  });

  it('groups the dialog into 连接 and 模型目录 cards with a read-only key status', async () => {
    const user = userEvent.setup();
    render(
      <App
        transport={createFakeTransport({
          sessions: [createIdleSession()],
          selectedSessionId: 'ses_idle',
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: '设置' }));

    const connection = screen.getByText('连接').parentElement;
    expect(connection?.contains(screen.getByLabelText('Base URL'))).toBe(true);

    const catalog = screen.getByText('模型目录').parentElement;
    expect(catalog?.contains(screen.getByRole('radio', { name: '自动发现' }))).toBe(true);
    expect(catalog?.contains(screen.getByRole('radio', { name: '手动维护' }))).toBe(true);
    expect(catalog?.contains(screen.getByLabelText('默认模型'))).toBe(true);
    expect(catalog?.contains(screen.getByLabelText('Base URL'))).toBe(false);

    const status = screen.getByTestId('api-key-status');
    expect(status.tagName).toBe('SPAN');
    expect(status.textContent).toBe('已通过环境变量配置');
    expect(screen.getByRole('list', { name: '发现的模型' }).textContent).toContain('echo-model');
  });

  it('uses a compact, model-specific delete action for a manual catalog', async () => {
    const user = userEvent.setup();
    render(
      <App
        transport={createFakeTransport({
          sessions: [createIdleSession()],
          selectedSessionId: 'ses_idle',
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('radio', { name: '手动维护' }));

    const deleteButton = screen.getByRole('button', { name: '删除模型 echo-model' });
    expect(deleteButton.textContent).toBe('删除');
    await user.click(deleteButton);
    expect(screen.queryByRole('button', { name: '删除模型 echo-model' })).toBeNull();
  });
});
