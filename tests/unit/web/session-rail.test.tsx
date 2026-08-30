// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionRail } from '../../../src/web/client/shell/session-rail.js';
import {
  createIdleSession,
  createRunningSession,
} from '../../../src/web/client/transport/fake-transport.js';

describe('Session rail', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders text-only session status without status icons', () => {
    render(
      <SessionRail
        canCreateSession
        createBlockedReason={undefined}
        onCreateSession={() => undefined}
        onOpenSettings={() => undefined}
        onSelectSession={() => undefined}
        selectedSessionId="ses_running"
        sessions={[createRunningSession(), createIdleSession()]}
        workspace={{ name: 'echo-harness', fingerprint: 'fp_local_fixture' }}
      />,
    );

    expect(screen.getByText(/ · Running · /)).toBeTruthy();
    expect(screen.getByText(/ · Idle · /)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTitle('Active coding session')).toBeTruthy();
  });

  it('creates a session from the primary rail action', async () => {
    const user = userEvent.setup();
    let created = false;
    render(
      <SessionRail
        canCreateSession
        createBlockedReason={undefined}
        onCreateSession={() => {
          created = true;
        }}
        onOpenSettings={() => undefined}
        onSelectSession={() => undefined}
        selectedSessionId={undefined}
        sessions={[]}
        workspace={{ name: 'echo-harness', fingerprint: 'fp_local_fixture' }}
      />,
    );

    await user.click(screen.getByRole('button', { name: '新会话' }));
    expect(created).toBe(true);
  });

  it('disables 新会话 and explains why when creation is blocked', () => {
    render(
      <SessionRail
        canCreateSession={false}
        createBlockedReason="provider_unavailable"
        onCreateSession={() => {
          throw new Error('createSession must not run when blocked');
        }}
        onOpenSettings={() => undefined}
        onSelectSession={() => undefined}
        selectedSessionId={undefined}
        sessions={[]}
        workspace={{ name: 'echo-harness', fingerprint: 'fp_local_fixture' }}
      />,
    );

    expect(screen.getByRole('button', { name: '新会话' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Provider 不可用或本地 API 不可达')).toBeTruthy();
  });
});
