import { test, expect } from '@playwright/test';

import { P2_B4_PENDING_WIRING } from '../../web-fixtures/pending-wiring.js';

test.describe('large Trace list', () => {
  test('renders two hundred Fake records without chunk or reasoning rows', async ({ page }) => {
    await page.goto('/?scenario=large-trace');
    const rows = page.getByRole('main').getByRole('list').getByRole('button');
    await expect(rows).toHaveCount(200);
    await expect(page.getByRole('main').getByText('chunk', { exact: true })).toHaveCount(0);

    await rows.last().click();
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await rows.first().click();
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible();

    expect(P2_B4_PENDING_WIRING.some((item) => item.id === 'trace-virtualization')).toBeTruthy();
  });
});
