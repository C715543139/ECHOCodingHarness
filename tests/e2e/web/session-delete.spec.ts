import { expect, test } from '@playwright/test';

test.describe('session deletion', () => {
  test('confirms before deleting an idle session', async ({ page }) => {
    await page.goto('/?scenario=completed');
    const title = 'Idle planning session';

    await page.getByRole('button', { name: `删除会话 ${title}` }).click();
    const dialog = page.getByRole('dialog', { name: '删除会话？' });
    await expect(dialog).toContainText('删除后将永久移除该会话记录，无法恢复。');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(page.getByTitle(title)).toBeVisible();

    await page.getByRole('button', { name: `删除会话 ${title}` }).click();
    await dialog.getByRole('button', { name: '删除会话', exact: true }).click();
    await expect(page.getByTitle(title)).toHaveCount(0);
    await expect(page.getByText('尚无 Session。新建会话后开始对话。')).toBeVisible();
  });

  test('stops a running Turn before deleting its session', async ({ page }) => {
    await page.goto('/?scenario=approval');
    const title = 'Active coding session';

    await page.getByRole('button', { name: `删除会话 ${title}` }).click();
    const dialog = page.getByRole('dialog', { name: '删除会话？' });
    await expect(dialog).toContainText('将先停止当前 Turn');
    await dialog.getByRole('button', { name: '停止并删除' }).click();

    await expect(page.getByTitle(title)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Idle planning session' })).toBeVisible();
    await expect(page.getByText('当前 Session 正在运行。')).toHaveCount(0);
  });
});
