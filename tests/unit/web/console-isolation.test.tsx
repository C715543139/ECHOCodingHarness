// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatView } from '../../../src/web/client/shell/chat-view.js';
import { SessionRail } from '../../../src/web/client/shell/session-rail.js';
import { SettingsModal } from '../../../src/web/client/shell/settings-modal.js';
import {
  createIdleSession,
  createRunningSession,
  createSessionRuntime,
} from '../../../src/web/client/transport/fake-transport.js';
import type {
  WebConsoleActions,
  WebConsoleView,
} from '../../../src/web/client/view-model/console-controller.js';
import * as consoleController from '../../../src/web/client/view-model/console-controller.js';
import { ChatHarness } from './web-console-harness.js';
import {
  createApprovalRequest,
  createFakeTransport,
  createSampleChatTurn,
} from '../../../src/web/client/transport/fake-transport.js';

function recordingActions(label: string, log: string[]): WebConsoleActions {
  return {
    changeRuntime: () => {
      log.push(`${label}:changeRuntime`);
    },
    respondToApproval: () => {
      log.push(`${label}:respondToApproval`);
    },
    resyncFromSnapshot: () => {
      log.push(`${label}:resync`);
    },
    loadMoreSessions: () => {
      log.push(`${label}:loadMore`);
    },
    discoverModels: () => {
      log.push(`${label}:discover`);
    },
    refreshExtensions: () => undefined,
    enableExtension: () => undefined,
    disableExtension: () => undefined,
    uninstallExtension: () => undefined,
  };
}

const moreView: WebConsoleView = {
  catalogModels: ['http-model'],
  loadingHistory: false,
  resyncRequired: false,
  hasMoreSessions: true,
  extensions: [],
  extensionsAvailable: false,
  extensionsLoading: false,
};

const idleCapabilities = {
  canCreateSession: true,
  canSubmitTurn: true,
  canChangeRuntime: true,
  canCancelTurn: false,
  canRespondToApproval: false,
};

describe('Web console isolation', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not export a module-level Fake bind or getter', () => {
    expect(consoleController).not.toHaveProperty('bindConsoleController');
    expect(consoleController).not.toHaveProperty('getConsoleController');
    expect(consoleController).not.toHaveProperty('active');
  });

  it('keeps actions isolated across two independently injected trees', async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    render(
      <div>
        <SessionRail
          actions={recordingActions('left', log)}
          canCreateSession
          createBlockedReason={undefined}
          onCreateSession={() => undefined}
          onOpenSettings={() => undefined}
          onSelectSession={() => undefined}
          selectedSessionId="ses_a"
          sessions={[createIdleSession({ id: 'ses_a', title: 'Left session' })]}
          view={moreView}
          workspace={{ name: 'left-ws', fingerprint: 'fp_left' }}
        />
        <SessionRail
          actions={recordingActions('right', log)}
          canCreateSession
          createBlockedReason={undefined}
          onCreateSession={() => undefined}
          onOpenSettings={() => undefined}
          onSelectSession={() => undefined}
          selectedSessionId="ses_b"
          sessions={[createIdleSession({ id: 'ses_b', title: 'Right session' })]}
          view={moreView}
          workspace={{ name: 'right-ws', fingerprint: 'fp_right' }}
        />
      </div>,
    );

    const loadButtons = screen.getAllByRole('button', { name: '加载更多' });
    const left = loadButtons[0];
    const right = loadButtons[1];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (left === undefined || right === undefined) {
      return;
    }
    await user.click(left);
    await user.click(right);
    expect(log).toEqual(['left:loadMore', 'right:loadMore']);
  });

  it('drops the previous tree actions after unmount so a replacement is not stale', async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    const first = recordingActions('first', log);
    const second = recordingActions('second', log);
    const idle = createIdleSession();
    const { unmount } = render(
      <ChatView
        actions={first}
        capabilities={idleCapabilities}
        composerText=""
        onCancel={() => undefined}
        onComposerText={() => undefined}
        onSubmit={() => undefined}
        session={createSessionRuntime(idle)}
        turns={[]}
        view={{ ...moreView, catalogModels: ['echo-model', 'echo-fast'] }}
      />,
    );

    unmount();
    render(
      <ChatView
        actions={second}
        capabilities={idleCapabilities}
        composerText=""
        onCancel={() => undefined}
        onComposerText={() => undefined}
        onSubmit={() => undefined}
        session={createSessionRuntime(idle)}
        turns={[]}
        view={{ ...moreView, catalogModels: ['echo-model', 'echo-fast'] }}
      />,
    );

    await user.selectOptions(screen.getByLabelText('模型'), 'echo-fast');
    expect(log).toEqual(['second:changeRuntime']);
    expect(log).not.toContain('first:changeRuntime');
  });

  it('accepts an HTTP-shaped controller that is not FakeTransport', async () => {
    const user = userEvent.setup();
    let discovered = false;
    const httpActions: WebConsoleActions = {
      changeRuntime: () => undefined,
      respondToApproval: () => undefined,
      resyncFromSnapshot: () => undefined,
      loadMoreSessions: () => undefined,
      discoverModels: () => {
        discovered = true;
      },
      refreshExtensions: () => undefined,
      enableExtension: () => undefined,
      disableExtension: () => undefined,
      uninstallExtension: () => undefined,
    };
    const httpView: WebConsoleView = {
      catalogModels: ['remote-model'],
      loadingHistory: false,
      resyncRequired: false,
      hasMoreSessions: false,
      extensions: [],
      extensionsAvailable: false,
      extensionsLoading: false,
      lastDiscoveredAt: undefined,
    };
    render(
      <SettingsModal
        actions={httpActions}
        onChange={() => undefined}
        onClose={() => undefined}
        onSave={() => undefined}
        provider={{
          baseUrl: 'https://provider.example/v1',
          catalog: { source: 'discover', cachedModels: ['remote-model'] },
          defaultModel: 'remote-model',
          apiKeyConfigured: true,
          writable: true,
        }}
        returnFocusTo={null}
        view={httpView}
      />,
    );

    await user.click(screen.getByRole('button', { name: '获取模型' }));
    expect(discovered).toBe(true);
  });

  it('disables controller-owned buttons and ignores empty Enter when unwired', async () => {
    const user = userEvent.setup();
    let submitted = 0;
    const running = createRunningSession();
    const approval = createApprovalRequest({ sessionId: running.id });
    render(
      <>
        <SessionRail
          canCreateSession
          createBlockedReason={undefined}
          onCreateSession={() => undefined}
          onOpenSettings={() => undefined}
          onSelectSession={() => undefined}
          selectedSessionId={running.id}
          sessions={[running]}
          view={{ ...moreView, hasMoreSessions: true }}
          workspace={{ name: 'echo-harness', fingerprint: 'fp_local_fixture' }}
        />
        <ChatView
          capabilities={{
            ...idleCapabilities,
            canSubmitTurn: true,
            canRespondToApproval: true,
            canCancelTurn: true,
            canChangeRuntime: false,
          }}
          composerText=""
          onCancel={() => undefined}
          onComposerText={() => undefined}
          onSubmit={() => {
            submitted += 1;
          }}
          session={{
            ...createSessionRuntime(running),
            pendingApproval: approval,
          }}
          turns={[
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
          ]}
          view={{ ...moreView, resyncRequired: true, hasMoreSessions: false }}
        />
        <SettingsModal
          onChange={() => undefined}
          onClose={() => undefined}
          onSave={() => undefined}
          provider={{
            baseUrl: 'https://provider.example/v1',
            catalog: { source: 'discover', cachedModels: ['echo-model'] },
            defaultModel: 'echo-model',
            apiKeyConfigured: true,
            writable: true,
          }}
          returnFocusTo={null}
        />
      </>,
    );

    expect(screen.getByRole('button', { name: '加载更多' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '重新同步' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '仅本次允许' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '获取模型' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('模型')).toHaveProperty('disabled', true);

    await user.click(screen.getByLabelText('输入'));
    await user.keyboard('{Enter}');
    expect(submitted).toBe(0);
  });

  it('still applies an injected Fake adapter for approval without using App wiring', async () => {
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

    await user.click(screen.getByRole('button', { name: '仅本次允许' }));
    expect(transport.getSnapshot().selectedRuntime?.pendingApproval).toBeUndefined();
    expect(screen.getByText('run_command · completed · 已按审批决定继续')).toBeTruthy();
  });
});
