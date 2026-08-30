import { test, expect } from '@playwright/test';

test.describe('responsive zoom and reduced motion', () => {
  test('keeps core controls at 200% zoom, a narrow viewport, and reduced motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 960, height: 900 });
    await page.goto('/?scenario=first-session');
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });

    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
    await expect(page.getByRole('button', { name: '设置' })).toBeVisible();
    await expect(page.getByTestId('connection-status')).toBeVisible();

    await page.evaluate(() => {
      document.documentElement.style.zoom = '1';
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Session' })).toBeVisible();
    expect(
      await page.evaluate(() => ({
        documentHeight: document.documentElement.scrollHeight,
        overflow: getComputedStyle(document.documentElement).overflow,
        viewportHeight: window.innerHeight,
      })),
    ).toEqual({ documentHeight: 844, overflow: 'hidden', viewportHeight: 844 });
  });
});
