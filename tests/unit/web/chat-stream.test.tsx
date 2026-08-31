// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import {
  createFakeTransport,
  createIdleSession,
  createSampleChatTurn,
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
    expect(
      screen
        .getByText('Hello from Fake Provider')
        .closest('[data-partial]')
        ?.getAttribute('data-partial'),
    ).toBe('true');
    expect(screen.queryByText('Hel')).toBeNull();
  });

  it('separates the user bubble, tool card status, and one composer card', async () => {
    const user = userEvent.setup();
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
      chatTurnsBySession: {
        ses_idle: [
          createSampleChatTurn({
            userText: 'run the suite',
            status: 'completed',
            stopReason: 'completed',
            toolSummaries: [
              {
                toolCallId: 'call_1',
                name: 'run_command',
                status: 'completed',
                resultSummary: 'exit 0',
              },
            ],
          }),
        ],
      },
    });
    render(<App transport={transport} />);

    const bubble = screen.getByText('run the suite');
    expect(bubble.tagName).toBe('P');
    expect(screen.getByRole('heading', { name: '用户' })).toBeTruthy();

    const tool = screen.getByText('run_command · completed · exit 0');
    expect(tool.getAttribute('data-status')).toBe('completed');
    const turn = screen.getByRole('article');
    expect(within(turn).getByText('completed', { exact: true })).toBeTruthy();
    expect(within(turn).queryByText('completed · completed', { exact: true })).toBeNull();

    const input = screen.getByLabelText('输入');
    const send = screen.getByRole('button', { name: '发送' });
    const card = input.closest('form')?.firstElementChild;
    expect(screen.getByTestId('chat-content').contains(bubble)).toBe(true);
    expect(screen.getByTestId('composer-card')).toBe(card);
    expect(card?.contains(input)).toBe(true);
    expect(card?.contains(send)).toBe(true);
    expect(card?.contains(screen.getByTestId('context-usage'))).toBe(true);

    await user.type(input, 'x');
    expect(send).toHaveProperty('disabled', false);
  });

  it('renders only agent responses as safe GFM Markdown', () => {
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
      chatTurns: [
        createSampleChatTurn({
          userText: '# 用户输入',
          responses: [
            {
              step: 1,
              partial: false,
              text: [
                '## 结果',
                '',
                '- **测试通过**',
                '',
                '`pnpm test`',
                '',
                '| 项目 | 状态 |',
                '| --- | --- |',
                '| tests | ok |',
                '',
                '[文档](https://example.com)',
                '',
                '[危险链接](javascript:alert(1))',
                '',
                '![架构图](https://example.com/tracker.png)',
                '',
                '<script>window.__unsafe = true</script>',
              ].join('\n'),
            },
          ],
        }),
      ],
    });
    render(<App transport={transport} />);

    const turn = screen.getByRole('article');
    expect(within(turn).getByText('# 用户输入').tagName).toBe('P');
    expect(within(turn).queryByRole('heading', { name: '用户输入' })).toBeNull();
    expect(within(turn).getByRole('heading', { level: 2, name: '结果' })).toBeTruthy();
    expect(within(turn).getByText('测试通过').tagName).toBe('STRONG');
    expect(within(turn).getByText('pnpm test').tagName).toBe('CODE');
    expect(within(turn).getByRole('table')).toBeTruthy();
    const link = within(turn).getByRole('link', { name: '文档' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(within(turn).queryByRole('link', { name: '危险链接' })).toBeNull();
    expect(within(turn).getByText('危险链接').tagName).toBe('SPAN');
    expect(within(turn).queryByRole('img')).toBeNull();
    expect(within(turn).getByText('[图片：架构图]')).toBeTruthy();
    expect(turn.textContent).not.toContain('window.__unsafe');
  });

  it('pauses tail follow after an upward scroll and restores it from 回到最新', async () => {
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

    const toast = screen.getByRole('button', { name: '回到最新' });
    expect(toast.parentElement?.className).toContain('toastLayer');
    expect(toast.compareDocumentPosition(screen.getByLabelText('输入'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await user.click(toast);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
  });
});
