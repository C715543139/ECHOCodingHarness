import { test, expect } from '@playwright/test';

test.describe('bootstrap', () => {
  test('loads the empty console without a paid provider', async ({ page }) => {
    expect(process.env.ECHO_API_KEY ?? '').not.toMatch(/^sk-/u);
    await page.goto('/?scenario=empty');
    await expect(page.getByText('ECHO', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '新会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '新会话' })).toBeVisible();
  });
});
