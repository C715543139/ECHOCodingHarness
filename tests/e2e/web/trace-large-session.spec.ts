import { test, expect } from '@playwright/test';

test.describe('large Trace list', () => {
  test('bounds and virtualizes the tail page of two hundred Fake records', async ({ page }) => {
    await page.goto('/?scenario=large-trace');
    const list = page.getByRole('main').getByRole('list');
    const rows = list.getByRole('listitem');
    await expect(rows.first()).toHaveAttribute('aria-setsize', '100');
    await expect(rows.first().getByRole('button')).toHaveAttribute('data-seq', '101');
    expect(await rows.count()).toBeLessThan(40);
    await expect(page.getByRole('main').getByText('chunk', { exact: true })).toHaveCount(0);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const last = list.locator('[role="listitem"][aria-posinset="100"]');
    await expect(last).toBeVisible();
    await expect(last.getByRole('button')).toHaveAttribute('data-seq', '200');
    await last.getByRole('button').click();
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = 120;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const backToLatest = page.getByRole('button', { name: '回到最新' });
    await expect(backToLatest).toBeVisible();
    expect(
      await backToLatest.evaluate((element) => ({
        bottom: getComputedStyle(element).bottom,
        fontSize: getComputedStyle(element).fontSize,
        height: element.getBoundingClientRect().height,
      })),
    ).toEqual({ bottom: '24px', fontSize: '15px', height: 36 });
    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await list.locator('[role="listitem"][aria-posinset="1"]').getByRole('button').click();
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible();
  });
});
