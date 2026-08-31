import { test, expect } from '@playwright/test';

test.describe('keyboard-only critical flow', () => {
  test('creates a session and restores focus from settings', async ({ page }) => {
    await page.goto('/?scenario=keyboard');
    await expect(page.getByRole('link', { name: '跳到主内容' })).toHaveCount(0);

    await page.getByRole('button', { name: '新会话', exact: true }).click();
    await page.getByLabel('输入').fill('列出工作区文件');
    await page.getByLabel('输入').press('Enter');
    await expect(page.getByText('Fake Provider 已接受该 Turn。')).toBeVisible();

    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Provider' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Provider' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused();
  });
});
