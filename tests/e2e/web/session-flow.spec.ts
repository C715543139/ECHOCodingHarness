import { test, expect } from '@playwright/test';

test.describe('bootstrap and first Session', () => {
  test('creates the first Fake Provider session from an empty console', async ({ page }) => {
    expect(process.env.ECHO_RUN_PROVIDER_SMOKE).toBeFalsy();
    await page.goto('/?scenario=empty');
    await expect(page.getByText('ECHO', { exact: true })).toBeVisible();
    await expect(page.getByText('尚无 Session。新建会话后开始对话。')).toBeVisible();
    await expect(page.getByTestId('workspace-name')).toHaveText('echo-harness');

    await page.getByRole('button', { name: '新会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '新会话' })).toBeVisible();
    await expect(page.getByText('开始对话。历史只投影聚合 Session 事实。')).toBeVisible();
    await expect(page.getByLabel('模型')).toBeVisible();
    await expect(page.getByTestId('connection-status')).toContainText('已连接');
  });
});
