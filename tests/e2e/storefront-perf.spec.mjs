import { expect, test } from '@playwright/test';

test('product images are CLS-safe and product structured data is injected (P16)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-product-grid] .product-card')).toHaveCount(12);

  const img = page.locator('[data-product-grid] .product-card img').first();
  await expect(img).toHaveAttribute('loading', 'lazy');
  await expect(img).toHaveAttribute('decoding', 'async');
  await expect(img).toHaveAttribute('width', '640');
  await expect(img).toHaveAttribute('height', '800');

  const jsonLd = await page.locator('script[data-product-jsonld]').textContent();
  expect(jsonLd).toContain('"@type":"ItemList"');
  expect(jsonLd).toContain('"@type":"Product"');
});

test('offline banner toggles with connectivity (P16)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-product-grid] .product-card')).toHaveCount(12);
  await expect(page.locator('[data-offline-banner]')).toBeHidden();

  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.locator('[data-offline-banner]')).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('[data-offline-banner]')).toBeHidden();
});

test('reduced-motion users get statically visible product cards (P16)', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('[data-product-grid] .product-card')).toHaveCount(12);
  const card = page.locator('[data-product-grid] .product-card.reveal').first();
  await expect(card).toHaveCSS('opacity', '1');
  await context.close();
});
