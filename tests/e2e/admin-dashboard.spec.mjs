import { expect, test } from '@playwright/test';

// Exercises the decrypted admin dashboard (P15 UX). Gated on the admin password so
// CI and contributors without it skip cleanly; run locally with:
//   PAVIA_ADMIN_PASSWORD='<pw>' npx playwright test admin-dashboard
const ADMIN_PASSWORD = process.env.PAVIA_ADMIN_PASSWORD || '';

test.describe('admin dashboard (decrypted)', () => {
  test.skip(!ADMIN_PASSWORD, 'set PAVIA_ADMIN_PASSWORD to run the decrypted-admin e2e');

  test('unlock, sort, inline edit, bulk select, and draft autosave', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

    await page.addInitScript(() => {
      localStorage.setItem('PAVIA_ORDERS', JSON.stringify([{
        id: 'order-admin-visible',
        orderNumber: 'PAV-ADMIN-TEST',
        status: 'new',
        paymentStatus: 'awaiting_confirmation',
        paymentMethod: 'cash_on_delivery',
        items: [{ id: 'blue-pearl-blouse', name: 'Blue Pearl Ruffle Blouse', qty: 1, price: 42 }],
        customer: { name: 'Dashboard Test', phone: '+96170000000', city: 'Beirut', address: 'Test address' },
        subtotal: 42,
        discount: 0,
        delivery: 4,
        total: 46,
        createdAt: new Date().toISOString(),
      }]));
    });

    await page.goto('/admin/index.html');

    // Unlock the encrypted bundle.
    await page.locator('#loginPass').fill(ADMIN_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
    await expect(page.locator('#dashboard')).toBeVisible();
    await expect(page.locator('#metricsGrid')).not.toContainText('Revenue');

    await page.locator('[data-tab="orders"]').click();
    await expect(page.locator('#availableOrders')).toContainText('PAV-ADMIN-TEST');

    // P15 helpers are available to the dashboard.
    const helpers = await page.evaluate(() => ({
      compare: typeof window.PaviaStoreCore.compareProducts === 'function',
      dedup: typeof window.PaviaStoreCore.shouldReuseImage === 'function',
    }));
    expect(helpers.compare).toBe(true);
    expect(helpers.dedup).toBe(true);

    // Open the products tab and wait for the catalog.
    await page.locator('[data-tab="products"]').click();
    await expect(page.locator('#productList .product-row')).toHaveCount(12);

    // Selecting a row reveals the bulk-actions bar.
    await page.locator('[data-select="ivory-oversized-shirt"]').check();
    await expect(page.locator('#bulkBar')).toBeVisible();
    await expect(page.locator('#bulkCount')).toHaveText('1');
    await page.locator('#bulkClear').click();
    await expect(page.locator('#bulkBar')).toBeHidden();

    // Sort by price puts the cheapest product first.
    await page.locator('#productSort').selectOption('price');
    await expect(page.locator('#productList .product-row').first()).toContainText('Ivory Oversized Shirt');

    // Inline stock edit persists to the backend (localStorage in local mode).
    await page.locator('[data-quick-stock="ivory-oversized-shirt"]').fill('3');
    await page.locator('[data-quick-stock="ivory-oversized-shirt"]').blur();
    await expect.poll(async () => page.evaluate(() => {
      const products = JSON.parse(localStorage.getItem('PAVIA_PRODUCTS') || '[]');
      return (products.find((p) => p.id === 'ivory-oversized-shirt') || {}).stock;
    })).toBe(3);

    // Editing the product form autosaves a recoverable draft.
    await page.locator('#prodName').fill('Draft Test Product');
    await page.locator('#prodDesc').fill('Draft description for autosave.');
    await page.locator('#prodPrice').fill('25');
    await expect.poll(async () => page.evaluate(() => {
      const draft = JSON.parse(localStorage.getItem('PAVIA_PRODUCT_DRAFT') || 'null');
      return draft && draft.name;
    })).toBe('Draft Test Product');

    expect(errors).toEqual([]);
  });
});
