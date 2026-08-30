// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';
import {
  createFakeTransport,
  createIdleSession,
} from '../../../src/web/client/transport/fake-transport.js';

describe('Session actions', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not register an export or download entry in the rail or settings', () => {
    render(
      <App
        transport={createFakeTransport({
          sessions: [createIdleSession()],
          selectedSessionId: 'ses_idle',
        })}
      />,
    );

    expect(screen.queryByRole('button', { name: /导出|下载|export|download/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /导出|下载|export|download/i })).toBeNull();
  });
});
