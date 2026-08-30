import { test, expect } from '@playwright/test';

import { P2_B4_PENDING_WIRING } from '../../web-fixtures/pending-wiring.js';

test.describe('disconnect reconnect resync', () => {
  test('flips Fake connection state without replaying a POST', async ({ page }) => {
    await page.goto('/?scenario=first-session');
    await expect(page.getByTestId('connection-status')).toContainText('已连接');
    await expect(page.getByTestId('connection-dot-connected')).toBeVisible();

    await page.evaluate(() => {
      const transport = (
        window as unknown as {
          __echoTransport?: { setConnection(state: 'disconnected' | 'reconnecting'): void };
        }
      ).__echoTransport;
      transport?.setConnection('disconnected');
    });
    await expect(page.getByTestId('connection-status')).toContainText('未连接');
    await expect(page.getByTestId('connection-dot-disconnected')).toBeVisible();
    await expect(
      page.getByRole('main').getByText('Provider 不可用或本地 API 不可达'),
    ).toBeVisible();

    await page.evaluate(() => {
      const transport = (
        window as unknown as {
          __echoTransport?: { setConnection(state: 'disconnected' | 'reconnecting'): void };
        }
      ).__echoTransport;
      transport?.setConnection('reconnecting');
    });
    await expect(page.getByText('正在重连')).toBeVisible();
    await expect(page.getByTestId('connection-status')).toContainText('未连接');

    expect(P2_B4_PENDING_WIRING.some((item) => item.id === 'sse-resync')).toBeTruthy();
  });
});
