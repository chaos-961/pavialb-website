import { expect, test } from '@playwright/test';

test('Drive upload controls are not mounted before admin unlock', async ({ page }) => {
  await page.goto('/admin/');
  await expect(page.locator('#adminGate')).toBeVisible();
  await expect(page.locator('#loginPass')).toHaveCount(1);
  await expect(page.locator('#loginUser')).toHaveCount(0);
  await expect(page.locator('#driveConnectBtn')).toHaveCount(0);
  await expect(page.locator('#prodImageFile')).toHaveCount(0);
  await expect(page.locator('#adminPayloadMount')).toBeHidden();
});
