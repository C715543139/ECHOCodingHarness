import { test, expect } from '@playwright/test';

test.describe('large Trace list', () => {
  test('bounds and virtualizes the tail page of two hundred Fake records', async ({ page }) => {
    await page.goto('/?scenario=large-trace');
    const list = page.getByRole('main').getByRole('list');
    const rows = list.getByRole('listitem');
    await expect(rows.first()).toHaveAttribute('aria-setsize', '100');
    expect(await rows.count()).toBeLessThan(40);
    await expect(page.getByRole('main').getByText('chunk', { exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    const last = list.locator('[role="listitem"][aria-posinset="100"]');
    await expect(last).toBeVisible();
    await expect(last.getByRole('button')).toHaveAttribute('data-seq', '200');
    await last.getByRole('button').click();
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    const inspectorResizer = page.getByRole('separator', { name: '调整 Inspector 宽度' });
    await expect(inspectorResizer).toHaveAttribute('aria-valuemin', '256');
    await expect(inspectorResizer).toHaveAttribute('aria-valuemax', '480');
    await inspectorResizer.focus();
    await inspectorResizer.press('End');
    await expect(inspectorResizer).toHaveAttribute('aria-valuenow', '480');
    await inspectorResizer.press('Home');
    await expect(inspectorResizer).toHaveAttribute('aria-valuenow', '256');
    expect(Math.round((await inspector.boundingBox())?.width ?? 0)).toBe(256);

    const inspectorScroll = page.getByTestId('inspector-scroll');
    const inspectorOverflow = await inspectorScroll.evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));
    expect(inspectorOverflow.overflowX).toBe('hidden');
    expect(inspectorOverflow.scrollWidth).toBeLessThanOrEqual(inspectorOverflow.clientWidth);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 16;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const backToLatest = page.getByRole('button', { name: '回到最新' });
    await expect(backToLatest).toBeVisible();
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
      )
      .toBeGreaterThanOrEqual(8);
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
