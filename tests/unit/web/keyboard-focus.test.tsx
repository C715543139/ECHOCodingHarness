// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import {
  createFakeTransport,
  createIdleSession,
} from '../../../src/web/client/transport/fake-transport.js';

describe('Keyboard and focus shell', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not inject the removed skip-navigation target', () => {
    render(<App />);

    expect(screen.queryByRole('link', { name: '跳到主内容' })).toBeNull();
    expect(screen.getByRole('main').getAttribute('id')).toBeNull();
    expect(screen.getByRole('main').getAttribute('tabindex')).toBeNull();
  });

  it('switches Chat and Trace from the header tabs', async () => {
    const user = userEvent.setup();
    render(
      <App
        transport={createFakeTransport({
          sessions: [createIdleSession()],
          selectedSessionId: 'ses_idle',
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '轨迹' }));
    expect(screen.getByText(/暂无 Trace 记录/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '对话' }));
    expect(screen.getByText(/开始对话/)).toBeTruthy();
  });
});
