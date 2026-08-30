import { test, expect } from '@playwright/test';

test.describe('accessibility', () => {
  test('keeps text status, a skip link, and a polite live region', async ({ page }, testInfo) => {
    await page.goto('/?scenario=first-session');
    await expect(page.getByRole('link', { name: '跳到主内容' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Session' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByTestId('connection-status')).toContainText('已连接');
    await expect(page.getByTestId('connection-dot-connected')).toBeVisible();
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: /^已连接$/u })).toHaveCount(
      1,
    );

    await page.screenshot({
      path: testInfo.outputPath('accessibility.png'),
      fullPage: true,
    });
  });
});
