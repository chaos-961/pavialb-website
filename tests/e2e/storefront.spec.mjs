import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-product-grid] .product-card')).toHaveCount(12);
});

test('loads storefront, searches, filters, sorts, and opens product modal', async ({ page }) => {
  await expect(page).toHaveTitle(/Pavia Lebanon/);
  await expect(page.locator('[data-product-grid]')).toBeVisible();

  await page.locator('#productSearch').fill('blouse');
  await expect(page.locator('[data-product-grid] .product-card')).toHaveCount(1);
  await expect(page.locator('[data-product-grid]')).toContainText('Blue Pearl Ruffle Blouse');

  await page.locator('[data-search-clear]').click();
  await page.locator('#sizeFilter').selectOption('XL');
  await page.locator('#priceFilter').selectOption('0-50');
  await page.locator('#sortFilter').selectOption('price-low');
  await expect(page.locator('[data-product-grid] .product-card').first()).toContainText(/\$\d+/);

  await page.locator('[data-quick-view="blue-pearl-blouse"]').click();
  await expect(page.locator('[data-product-modal]')).toHaveClass(/is-open/);
  await expect(page.locator('#modalTitle')).toContainText('Blue Pearl Ruffle Blouse');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-product-modal]')).not.toHaveClass(/is-open/);
});

test('adds to cart, applies promo, saves wishlist, and validates checkout phone', async ({ page, context }) => {
  await context.route('https://wa.me/**', (route) => route.abort());
  await page.locator('[data-wish="blue-pearl-blouse"]').click();
  await expect(page.locator('[data-wishlist-count]').first()).toHaveText('1');

  await page.locator('[data-fast-add="blue-pearl-blouse"]').click();
  await page.locator('[data-open-cart]').first().click();
  await expect(page.locator('[data-cart-drawer]')).toHaveClass(/is-open/);
  await expect(page.locator('[data-cart-items] .cart-row')).toHaveCount(1);
  await expect(page.locator('[data-subtotal]')).toHaveText('$42');

  await page.locator('[data-promo-input]').fill('PAVIA10');
  await page.locator('[data-promo-apply]').click();
  await expect(page.locator('[data-discount-line]')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('[data-discount]')).toHaveText('-$4');

  await page.locator('[data-checkout]').click();
  await expect(page.locator('[data-checkout-modal]')).toHaveClass(/is-open/);
  await page.locator('[name="name"]').fill('Pavia Smoke Test');
  await page.locator('[name="phone"]').fill('12345');
  await page.locator('[name="city"]').fill('Beirut');
  await page.locator('[name="deliveryArea"]').selectOption('beirut');
  await page.locator('[name="address"]').fill('Test building, floor 1');
  await page.locator('[name="reviewConfirmed"]').check();
  await page.locator('[data-checkout-form] [type="submit"]').click();
  await expect(page.locator('[data-checkout-modal]')).toHaveClass(/is-open/);
  await expect(page.locator('[data-checkout-success]')).toHaveClass(/is-hidden/);
  await expect(page.getByText('Enter a valid Lebanese phone number.')).toBeVisible();
});

test('mobile storefront has no horizontal overflow', async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  const viewport = page.viewportSize();
  if ((viewport?.width || 0) <= 700) {
    await expect(page.locator('.bottom-nav')).toBeVisible();
  }
});
