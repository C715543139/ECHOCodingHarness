import { expect, test } from '@playwright/test';

test.describe('P3 Full Access and workspace extensions', () => {
  test('requires confirmation and restores the persistent Full Access warning', async ({
    page,
  }) => {
    await page.goto('/?scenario=p3-extensions');
    await page.getByLabel('安全模式').selectOption('full-access');

    const dialog = page.getByRole('dialog', { name: '确认启用 Full Access' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('访问网络、安装依赖、执行 Git 写操作、删除文件');
    await expect(page.getByText('FULL ACCESS', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('安全模式')).toBeFocused();

    await page.getByLabel('安全模式').selectOption('full-access');
    await page.getByRole('button', { name: '确认启用 Full Access' }).click();
    await expect(page.getByText('FULL ACCESS', { exact: true })).toBeVisible();

    await page.goto('/?scenario=p3-full-access');
    await expect(page.getByText('FULL ACCESS', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('FULL ACCESS', { exact: true })).toBeVisible();
  });

  test('manages extensions in safe mode with confirmation, recovery, and private output', async ({
    page,
  }) => {
    await page.goto('/?scenario=p3-extensions');
    await expect(page.getByLabel('安全模式')).toHaveValue('safe');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '扩展', exact: true }).click();

    const settings = page.getByRole('dialog', { name: '扩展' });
    await expect(settings.getByText('pdf-reader', { exact: true })).toBeVisible();
    await expect(settings.getByText('1.0.0', { exact: true })).toBeVisible();
    await expect(settings.getByText(/^sha256:b{64}$/u)).toBeVisible();
    await expect(settings.getByText('read_pdf、pdf_metadata')).toBeVisible();
    await settings.getByRole('button', { name: '禁用 pdf-reader' }).click();
    await expect(settings.getByText('disabled', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '启用 pdf-reader' }).click();
    await expect(settings.getByText('enabled', { exact: true })).toBeVisible();

    const uninstall = settings.getByRole('button', { name: '卸载 pdf-reader' });
    await uninstall.click();
    await expect(page.getByRole('dialog', { name: '确认卸载 pdf-reader' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(uninstall).toBeFocused();
    await uninstall.click();
    await page.getByRole('button', { name: '确认卸载 pdf-reader' }).click();
    await expect(settings.getByText('当前工作区没有已安装扩展。')).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '扩展', exact: true }).click();
    await expect(page.getByText('pdf-reader', { exact: true })).toBeVisible();
    const visible = await page.getByRole('dialog', { name: '扩展' }).innerText();
    expect(visible).not.toMatch(/ECHO_API_KEY|reasoningContent|C:\\Users\\|\/home\//u);
  });
});
