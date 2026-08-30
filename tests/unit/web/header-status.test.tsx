// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionStatus } from '../../../src/web/client/shell/connection-status.js';

describe('Header connection status', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows a green dot and 已连接 text together', () => {
    render(<ConnectionStatus state="connected" />);

    expect(screen.getByText('已连接')).toBeTruthy();
    expect(screen.getByTestId('connection-dot-connected')).toBeTruthy();
    expect(screen.queryByText('未连接')).toBeNull();
  });

  it('shows a red dot and 未连接 text together', () => {
    render(<ConnectionStatus state="disconnected" />);

    expect(screen.getByText('未连接')).toBeTruthy();
    expect(screen.getByTestId('connection-dot-disconnected')).toBeTruthy();
    expect(screen.queryByText('已连接')).toBeNull();
  });

  it('keeps 未连接 as the primary label while reconnecting', () => {
    render(<ConnectionStatus state="reconnecting" />);

    expect(screen.getByText('未连接')).toBeTruthy();
    expect(screen.getByText('正在重连')).toBeTruthy();
    expect(screen.getByTestId('connection-dot-disconnected')).toBeTruthy();
  });
});
