import { expect, test } from '@playwright/test';

// Reads the P14 IndexedDB catalog cache from the page context.
async function readCatalogDb(page) {
  return page.evaluate(() => new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open('pavia-catalog', 1);
    } catch {
      resolve(null);
      return;
    }
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const transaction = db.transaction(['catalog', 'meta', 'images'], 'readonly');
        const catalogReq = transaction.objectStore('catalog').getAll();
        const imageReq = transaction.objectStore('images').getAll();
        const schemaReq = transaction.objectStore('meta').get('schema');
        transaction.oncomplete = () => resolve({
          catalog: (catalogReq.result || []).length,
          images: (imageReq.result || []).length,
          schema: schemaReq.result ? schemaReq.result.value : null,
        });
        transaction.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    };
  }));
}

test('persists the catalog and resolved images to IndexedDB (P14)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-product-grid] .product-card')).toHaveCount(12);
  await page.waitForTimeout(400); // let writeCatalog / putResolvedImage commit

  const state = await readCatalogDb(page);
  expect(state).not.toBeNull();
  expect(state.catalog).toBeGreaterThanOrEqual(12);
  expect(state.images).toBeGreaterThan(0); // resolved-image-URL cache populated
  expect(state.schema).toBe(2); // namespaced by backend schemaVersion
});

test('repaints from the cached catalog on reload (P14)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-product-grid] .product-card')).toHaveCount(12);
  await page.waitForTimeout(400);

  // Reload with the cache already populated exercises the stale-while-revalidate paint.
  await page.reload();
  await expect(page.locator('[data-product-grid] .product-card')).toHaveCount(12);
  await expect(page.locator('[data-product-grid]')).toContainText('Blue Pearl Ruffle Blouse');
});
