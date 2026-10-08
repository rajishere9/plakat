/**
 * (b) Editor ↔ export parity, render-export-pipeline.md §6.2: in a multi-page design,
 * at a zoom other than 100 % and with the page scrolled, the editor's own PageScene
 * rasterized through window.__plakat.snapshotContentLayer(pageId, s) must equal the PNG
 * the real "Download" button produces, pixel for pixel (pixelmatch threshold 0), for
 * s = 1 and 2. Run at devicePixelRatio 1 and 2 (the on-screen scene ratio is zoom × dpr).
 */
import { expect, test, type Page } from '@playwright/test';
import { comparePngs, createDesignFromTemplate, exportViaDialog, getDocument, snapshotPage, trackPageErrors } from './helpers.ts';

const EXPECTED_A4 = { '1x': { width: 794, height: 1123 }, '2x': { width: 1587, height: 2245 } } as const;

async function zoomAndScrollToSecondPage(page: Page): Promise<string> {
  const doc = await getDocument(page);
  expect(doc.pages.length).toBeGreaterThan(1);
  const second = doc.pages[1]!.id;

  // Zoom through the top-bar input (not 100 %, not "fit").
  const zoomInput = page.getByRole('textbox', { name: 'Zoom level (percent)' });
  await zoomInput.click();
  await zoomInput.fill('37');
  await zoomInput.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__plakat!.store.getState().zoom)).toBeCloseTo(0.37, 5);

  // Scroll the canvas with the mouse wheel until page 2 is the active page.
  const stage = page.locator('[data-plakat-stage]');
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30; i++) {
    const active = await page.evaluate(() => window.__plakat!.store.getState().activePageId);
    if (active === second) break;
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(60);
  }
  await expect.poll(() => page.evaluate(() => window.__plakat!.store.getState().activePageId)).toBe(second);

  const view = await page.evaluate(() => window.__plakat!.getView());
  expect(view.zoom).toBeCloseTo(0.37, 5);
  expect(view.panY).not.toBe(0); // the page really is scrolled
  await page.evaluate(() => window.__plakat!.ready());
  return second;
}

for (const dpr of [1, 2]) {
  test.describe(`devicePixelRatio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test('snapshotContentLayer equals the downloaded PNG at 1x and 2x (multi-page A4, zoomed, scrolled)', async ({ page }) => {
      const errors = trackPageErrors(page);
      await createDesignFromTemplate(page, 'Café menu');
      const pageId = await zoomAndScrollToSecondPage(page);

      for (const scale of ['1x', '2x'] as const) {
        const snapshot = await snapshotPage(page, pageId, scale);
        const download = await exportViaDialog(page, { format: 'png', scale, pages: 'current' });
        expect(download.filename).toMatch(/-02\.png$/);
        const r = comparePngs(snapshot, download.bytes);
        expect({ width: r.width, height: r.height }).toEqual(EXPECTED_A4[scale]);
        expect(r.diff, `pixelmatch diff at ${scale}`).toBe(0);
        expect(r.bytesEqual).toBe(true);
      }

      // Zoom/pan must not leak into the snapshot: a different view gives the same bytes.
      const before = await snapshotPage(page, pageId, 1);
      await page.evaluate(() => {
        window.__plakat!.store.getState().actions.setZoom(1.6);
        window.__plakat!.setPan(-137.5, -911.25);
      });
      const after = await snapshotPage(page, pageId, 1);
      expect(comparePngs(before, after).diff).toBe(0);

      expect(errors).toEqual([]);
    });
  });
}
