// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createApprovalRequest,
  createFakeTransport,
  createIdleSession,
  createRunningSession,
  createSampleChatTurn,
} from '../../../src/web/client/transport/fake-transport.js';
import { ChatHarness } from './web-console-harness.js';

describe('Chat approval card', () => {
  afterEach(() => {
    cleanup();
  });

  it('binds deny / once / session decisions and ignores a repeated click', async () => {
    const user = userEvent.setup();
    const running = createRunningSession();
    const approval = createApprovalRequest({ sessionId: running.id, turnId: 'turn_active' });
    const transport = createFakeTransport({
      sessions: [running],
      selectedSessionId: running.id,
      pendingApproval: approval,
      chatTurns: [
        createSampleChatTurn({
          turnId: 'turn_active',
          status: 'running',
          toolSummaries: [
            {
              toolCallId: approval.toolCallId,
              name: approval.toolName,
              status: 'awaiting_approval',
              resultSummary: approval.actionSummary,
            },
          ],
        }),
      ],
    });
    render(<ChatHarness transport={transport} />);

    expect(screen.getByRole('heading', { name: '等待审批' })).toBeTruthy();
    expect(document.activeElement).not.toBe(screen.getByTestId('approval-card'));

    await user.click(screen.getByRole('button', { name: '仅本次允许' }));
    expect(transport.getSnapshot().selectedRuntime?.pendingApproval).toBeUndefined();
    expect(screen.getByText('run_command · completed · 已按审批决定继续')).toBeTruthy();

    act(() => {
      transport.respondToApproval('allow_once');
    });
    expect(screen.getByText('审批已处理或已过期，未再次执行工具。')).toBeTruthy();
    expect(JSON.stringify(transport.getSnapshot())).not.toMatch(/sk-[A-Za-z0-9]|ECHO_API_KEY/);
  });

  it('accepts y / s / n once the approval card is focused', async () => {
    const user = userEvent.setup();
    const running = createRunningSession();
    const approval = createApprovalRequest({ sessionId: running.id });
    const transport = createFakeTransport({
      sessions: [running, createIdleSession()],
      selectedSessionId: running.id,
      pendingApproval: approval,
      chatTurns: [
        createSampleChatTurn({
          turnId: approval.turnId,
          status: 'running',
          toolSummaries: [
            {
              toolCallId: approval.toolCallId,
              name: approval.toolName,
              status: 'awaiting_approval',
            },
          ],
        }),
      ],
    });
    render(<ChatHarness transport={transport} />);
    screen.getByTestId('approval-card').focus();
    await user.keyboard('n');

    expect(transport.getSnapshot().sessions[0]?.phase).toBe('cancelled');
    expect(screen.getByText('run_command · denied · 用户拒绝')).toBeTruthy();
  });
});
