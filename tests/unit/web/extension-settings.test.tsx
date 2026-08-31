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

const HASH = `sha256:${'b'.repeat(64)}`;

describe('Extension settings', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows bounded extension facts and manages them from a safe Session', async () => {
    const user = userEvent.setup();
    const session = createIdleSession({ safetyMode: 'safe' });
    const transport = createFakeTransport({
      sessions: [session],
      selectedSessionId: session.id,
      extensions: [
        {
          id: 'pdf-reader',
          version: '1.0.0',
          contentHash: HASH,
          state: 'enabled',
          tools: ['read_pdf', 'pdf_metadata'],
          loaded: true,
          cleanupPending: false,
        },
      ],
    });
    render(<App transport={transport} />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '扩展' }));
    expect(screen.getByRole('heading', { name: '扩展' })).toBeTruthy();
    expect(screen.getByText('pdf-reader')).toBeTruthy();
    expect(screen.getByText('1.0.0')).toBeTruthy();
    expect(screen.getByText('read_pdf、pdf_metadata')).toBeTruthy();
    expect(screen.getByText(HASH)).toBeTruthy();
    expect(screen.getByText('enabled')).toBeTruthy();
    expect(screen.getByText('已加载')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '禁用 pdf-reader' }));
    expect(transport.getSnapshot().extensions[0]).toMatchObject({
      state: 'disabled',
      loaded: false,
    });
    await user.click(screen.getByRole('button', { name: '启用 pdf-reader' }));
    expect(transport.getSnapshot().extensions[0]).toMatchObject({
      state: 'enabled',
      loaded: true,
    });
  });

  it('keeps human management available during any Session mode and confirms uninstall', async () => {
    const user = userEvent.setup();
    const running = createRunningSession({ safetyMode: 'balanced' });
    const transport = createFakeTransport({
      sessions: [running],
      selectedSessionId: running.id,
      extensions: [
        {
          id: 'pdf-reader',
          version: '1.0.0',
          contentHash: HASH,
          state: 'disabled',
          tools: ['read_pdf'],
          loaded: false,
          cleanupPending: false,
        },
      ],
    });
    render(<App transport={transport} />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '扩展' }));
    expect(screen.getByRole('button', { name: '启用 pdf-reader' })).toHaveProperty(
      'disabled',
      false,
    );
    const uninstallButton = screen.getByRole('button', { name: '卸载 pdf-reader' });
    await user.click(uninstallButton);
    expect(screen.getByRole('dialog', { name: '确认卸载 pdf-reader' })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: '确认卸载 pdf-reader' }),
    );
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '确认卸载 pdf-reader' }),
    );
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(uninstallButton);
    expect(transport.getSnapshot().extensions).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '卸载 pdf-reader' }));
    await user.click(screen.getByRole('button', { name: '确认卸载 pdf-reader' }));
    expect(transport.getSnapshot().extensions).toEqual([]);
  });

  it('retains extension facts and reports actionable failures without leaking details', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
      extensions: [
        {
          id: 'pdf-reader',
          version: '1.0.0',
          contentHash: HASH,
          state: 'enabled',
          tools: ['read_pdf'],
          loaded: true,
          quarantineReason: 'Worker initialization failed.',
          cleanupPending: true,
        },
      ],
      extensionFailure: {
        action: 'disable',
        code: 'EXTENSION_BUSY',
        message: '扩展正在调用中，请先停止当前 Turn。',
      },
    });
    render(<App transport={transport} />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '扩展' }));
    await user.click(screen.getByRole('button', { name: '禁用 pdf-reader' }));
    expect((await screen.findByRole('alert')).textContent).toContain('请先停止当前 Turn');
    expect(transport.getSnapshot().extensions[0]?.state).toBe('enabled');
    expect(screen.getByText('需要清理')).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/ECHO_API_KEY|reasoningContent|C:\\Users\\/u);

    await user.click(screen.getByRole('button', { name: 'Provider' }));
    await user.click(screen.getByRole('button', { name: '扩展' }));
    expect(screen.getByText('pdf-reader')).toBeTruthy();
  });

  it('hides extension navigation until the production administration port is available', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({ extensionsAvailable: false });
    render(<App transport={transport} />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.queryByRole('button', { name: '扩展' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Provider' })).toBeTruthy();
  });
});
