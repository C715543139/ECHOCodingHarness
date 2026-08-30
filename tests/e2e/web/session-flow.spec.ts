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

  test('keeps the desktop shell fixed while rail and model catalog own their scrolling', async ({
    page,
  }) => {
    await page.goto('/?scenario=first-session');

    const rail = page.getByRole('navigation', { name: 'Session' });
    const separator = page.getByRole('separator', { name: '调整会话栏宽度' });
    const before = await rail.boundingBox();
    const handle = await separator.boundingBox();
    expect(before).not.toBeNull();
    expect(handle).not.toBeNull();
    if (before === null || handle === null) return;

    await page.mouse.move(handle.x + handle.width / 2, handle.y + 20);
    await page.mouse.down();
    await page.mouse.move(handle.x + 100, handle.y + 20);
    await page.mouse.up();
    const after = await rail.boundingBox();
    expect(after?.width).toBeGreaterThan(before.width + 70);

    const viewport = await page.evaluate(() => ({
      height: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    }));
    expect(viewport.documentHeight).toBe(viewport.height);

    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: '获取模型' }).click();
    const modelList = page.getByRole('list', { name: '发现的模型' });
    await expect(modelList).toBeVisible();
    expect(
      await modelList.evaluate((element) => ({
        maxHeight: getComputedStyle(element).maxHeight,
        overflowY: getComputedStyle(element).overflowY,
      })),
    ).toEqual({ maxHeight: '176px', overflowY: 'auto' });
  });
});
