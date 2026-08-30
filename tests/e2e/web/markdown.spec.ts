import { expect, test } from '@playwright/test';

test.describe('model Markdown', () => {
  test('renders semantic GFM without interpreting user text or loading remote images', async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://example.com/')) {
        externalRequests.push(request.url());
      }
    });

    await page.goto('/?scenario=completed');

    await expect(page.getByText('# 列出工作区文件', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '列出工作区文件' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: '完成结果' })).toBeVisible();
    await expect(page.getByText('状态', { exact: true })).toHaveCSS('font-weight', '700');
    await expect(page.getByText('pnpm test', { exact: true })).toHaveCSS(
      'font-family',
      /Cascadia Code|Sarasa Mono SC|Consolas/u,
    );
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByText('[图片：构建图]')).toBeVisible();
    await expect(page.locator('img')).toHaveCount(0);
    expect(externalRequests).toEqual([]);
  });
});
