import { test, expect, type Locator } from '@playwright/test';

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

    const viewport = await page.evaluate(() => {
      const chat = document.querySelector<HTMLElement>('[data-testid="chat-scroll"]');
      const root = document.querySelector<HTMLElement>('#root');
      return {
        height: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
        bodyOverflow: getComputedStyle(document.body).overflow,
        rootOverflow: root === null ? undefined : getComputedStyle(root).overflow,
        chatOverflowX: chat === null ? undefined : getComputedStyle(chat).overflowX,
        chatOverflowY: chat === null ? undefined : getComputedStyle(chat).overflowY,
      };
    });
    expect(viewport).toEqual({
      height: viewport.height,
      documentHeight: viewport.height,
      htmlOverflow: 'hidden',
      bodyOverflow: 'hidden',
      rootOverflow: 'hidden',
      chatOverflowX: 'hidden',
      chatOverflowY: 'auto',
    });

    const typography = async (locator: Locator) =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight,
        };
      });
    const workspaceCaption = page.getByText('当前工作区', { exact: true });
    const sessionCaption = page.getByText('会话', { exact: true });
    const workspaceName = page.getByTestId('workspace-name');
    const sessionTitle = rail.locator('button[title] > span').first();
    expect(await typography(sessionCaption)).toEqual(await typography(workspaceCaption));
    expect(await typography(workspaceName)).toEqual(await typography(sessionTitle));

    const modelSelect = page.getByLabel('模型');
    const safetySelect = page.getByLabel('安全模式');
    for (const select of [modelSelect, safetySelect]) {
      expect(
        await select.evaluate((element) => ({
          height: getComputedStyle(element).height,
          lineHeight: getComputedStyle(element).lineHeight,
          paddingBottom: getComputedStyle(element).paddingBottom,
          paddingTop: getComputedStyle(element).paddingTop,
        })),
      ).toEqual({ height: '32px', lineHeight: 'normal', paddingBottom: '0px', paddingTop: '0px' });
    }

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
