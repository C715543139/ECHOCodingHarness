import { test, expect } from '@playwright/test';

test.describe('approval fixture', () => {
  test('projects a pending approval with wired actions and matching Trace', async ({ page }) => {
    await page.goto('/?scenario=approval');
    await expect(page.getByText('需要审批后才能执行命令。')).toBeVisible();
    await expect(page.getByText('另一会话正在运行')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '拒绝' })).toBeVisible();
    await expect(page.getByRole('button', { name: '仅本次允许' })).toBeVisible();
    await expect(page.getByRole('button', { name: '本 Session 允许' })).toBeVisible();

    await page.getByRole('button', { name: '轨迹', exact: true }).click();
    await page.getByRole('button', { name: /approval/ }).click();
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await expect(page.getByRole('complementary').getByText('目标：在工作区运行测试')).toBeVisible();

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/sk-[A-Za-z0-9]/u);
    expect(body).not.toContain('ECHO_API_KEY');
  });
});
