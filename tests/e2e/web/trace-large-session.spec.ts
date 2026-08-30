import { test, expect } from '@playwright/test';

import { P2_B4_PENDING_WIRING } from '../../web-fixtures/pending-wiring.js';

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
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await list.locator('[role="listitem"][aria-posinset="1"]').getByRole('button').click();
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible();

    expect(P2_B4_PENDING_WIRING.some((item) => item.id === 'trace-http-pagination')).toBeTruthy();
  });
});
