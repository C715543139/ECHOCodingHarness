import { test, expect } from '@playwright/test';

import { P2_B4_PENDING_WIRING } from '../../web-fixtures/pending-wiring.js';

test.describe('approval fixture', () => {
  test('projects a pending approval Trace without rendering B2 action buttons', async ({
    page,
  }) => {
    await page.goto('/?scenario=approval');
    await expect(page.getByText('需要审批后才能执行命令。')).toBeVisible();
    await expect(page.getByText('另一会话正在运行')).toHaveCount(0);

    await page.getByRole('button', { name: '轨迹', exact: true }).click();
    await page.getByRole('button', { name: /approval/ }).click();
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await expect(page.getByRole('complementary').getByText('目标：在工作区运行测试')).toBeVisible();

    await expect(page.getByRole('button', { name: '拒绝' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '仅本次' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '本 Session' })).toHaveCount(0);
    expect(P2_B4_PENDING_WIRING.some((item) => item.id === 'chat-approval-actions')).toBeTruthy();

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/sk-[A-Za-z0-9]/u);
    expect(body).not.toContain('ECHO_API_KEY');
  });
});
