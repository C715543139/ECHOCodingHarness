import { describe, expect, it } from 'vitest';

import {
  createFakeTransport,
  createIdleSession,
  createRunningSession,
} from '../../../src/web/client/transport/fake-transport.js';

describe('Fake console transport', () => {
  it('projects frozen Web DTOs without secrets or absolute paths', () => {
    const transport = createFakeTransport({
      sessions: [createIdleSession()],
      selectedSessionId: 'ses_idle',
    });
    const snapshot = transport.getSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.bootstrap.workspace.name).toBe('echo-harness');
    expect(snapshot.bootstrap.provider.apiKeyConfigured).toBe(true);
    expect(serialized).not.toMatch(/ECHO_API_KEY|sk-[A-Za-z0-9]|apiKey[^C]/);
    expect(snapshot.bootstrap.workspace.name).not.toMatch(/[/\\:]/);
    expect(snapshot.bootstrap.capabilities.canSubmitTurn).toBe(true);
  });

  it('blocks submit on a non-active session while a process-wide Turn is running', () => {
    const transport = createFakeTransport({
      sessions: [createRunningSession(), createIdleSession()],
      selectedSessionId: 'ses_idle',
    });

    expect(transport.getSnapshot().bootstrap.capabilities.canSubmitTurn).toBe(false);
    expect(transport.getSnapshot().bootstrap.capabilities.submitTurnBlockedReason).toBe(
      'turn_active',
    );
    expect(transport.getSnapshot().bootstrap.capabilities.canCancelTurn).toBe(false);
  });

  it('refuses to create a session when disconnected and keeps create enabled during an active Turn', () => {
    const disconnected = createFakeTransport({ connection: 'disconnected' });
    disconnected.createSession();
    expect(disconnected.getSnapshot().sessions).toEqual([]);
    expect(disconnected.getSnapshot().bootstrap.capabilities.canCreateSession).toBe(false);
    expect(disconnected.getSnapshot().bootstrap.capabilities.createSessionBlockedReason).toBe(
      'provider_unavailable',
    );

    const running = createFakeTransport({
      sessions: [createRunningSession()],
      selectedSessionId: 'ses_running',
    });
    expect(running.getSnapshot().bootstrap.capabilities.canCreateSession).toBe(true);
    running.createSession();
    expect(running.getSnapshot().sessions).toHaveLength(2);
  });

  it('pages sessions and keeps process-wide running state when a later page is hidden', () => {
    const transport = createFakeTransport({
      sessionPageSize: 1,
      sessions: [createIdleSession(), createRunningSession()],
      selectedSessionId: 'ses_idle',
    });

    expect(transport.getSnapshot().sessions).toHaveLength(1);
    expect(transport.getSnapshot().bootstrap.capabilities.submitTurnBlockedReason).toBe(
      'turn_active',
    );
    transport.loadMoreSessions();
    expect(transport.getSnapshot().sessions).toHaveLength(2);
  });
});
