import { test, expect } from '@playwright/test';

test.describe('Provider secret', () => {
  test('shows apiKeyConfigured without putting a key into the DOM', async ({ page }) => {
    await page.goto('/?scenario=provider-secret');
    await page.getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('dialog', { name: 'Provider' })).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'Provider' });
    await expect(dialog.getByTestId('api-key-status')).toHaveText('已通过环境变量配置');
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByLabel('Base URL')).toHaveValue('https://provider.example/v1');

    const visible = await dialog.innerText();
    expect(visible).not.toMatch(/sk-[A-Za-z0-9]/u);
    expect(visible).not.toContain('ECHO_API_KEY');
    expect(visible).not.toContain('isolated-web-smoke-key');
  });
});
