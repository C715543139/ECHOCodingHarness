// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import {
  createFakeTransport,
  createIdleSession,
} from '../../../src/web/client/transport/fake-transport.js';

describe('Chat streaming projection', () => {
  afterEach(() => {
    cleanup();
  });

  it('updates one stable Chat record while Fake text streams', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
      turnScript: 'stream',
    });
    render(<App transport={transport} />);

    await user.type(screen.getByLabelText('输入'), 'stream please');
    await user.keyboard('{Enter}');
    act(() => {
      transport.advanceStream('Hel');
      transport.advanceStream('Hello from Fake Provider');
    });

    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(1);
    expect(articles[0]?.getAttribute('data-turn-id')).toBe('turn_1');
    expect(screen.getByText('Hello from Fake Provider')).toBeTruthy();
    expect(screen.getByText('Hello from Fake Provider').getAttribute('data-partial')).toBe('true');
    expect(screen.queryByText('Hel')).toBeNull();
  });

  it('pauses tail follow after an upward scroll and restores it from 有新内容', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
      turnScript: 'stream',
    });
    render(<App transport={transport} />);
    await user.type(screen.getByLabelText('输入'), 'follow');
    await user.keyboard('{Enter}');

    const scroller = screen.getByTestId('chat-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 800 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 120 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 });
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      transport.advanceStream('later text');
    });

    expect(screen.getByRole('button', { name: '有新内容' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '有新内容' }));
    expect(screen.queryByRole('button', { name: '有新内容' })).toBeNull();
  });
});
