/**
 * (e) Image upload → crop (crop mode, dragging a crop handle) → filters (sliders) →
 * export at 2x through the dialog, pixel-identical to the editor's own snapshot.
 */
import { expect, test } from '@playwright/test';
import type { ImageElement } from '@plakat/schema';
import { comparePngs, createDesignFromPreset, exportViaDialog, getDocument, makeTestPng, pageToClient, snapshotPage, trackPageErrors } from './helpers.ts';

test('upload an image, crop it, adjust filters, export 2x = snapshot', async ({ page }) => {
  const errors = trackPageErrors(page);
  await createDesignFromPreset(page, 'Instagram post');

  // --- upload through the Uploads panel, then insert ----------------------------------------
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Uploads' }).click();
  await page.getByLabel('Choose images to upload').setInputFiles({ name: 'e2e-photo.png', mimeType: 'image/png', buffer: makeTestPng(1200, 800) });
  const tile = page.getByRole('button', { name: 'Insert e2e-photo' });
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await tile.click();

  let doc = await getDocument(page);
  const pageId = doc.pages[0]!.id;
  const img = doc.pages[0]!.elements.find((e): e is ImageElement => e.type === 'image')!;
  expect(img).toBeTruthy();
  const asset = doc.assets[img.assetId]!;
  expect(asset).toMatchObject({ width: 1200, height: 800, mimeType: 'image/png' });
  expect(asset.src).toMatch(/^\/uploads\/[0-9a-f]{64}\.png$/);
  expect(img.width / img.height).toBeCloseTo(1.5, 3);
  expect(img.crop).toBeNull();
  await page.evaluate(() => window.__plakat!.ready());
  expect(await page.evaluate(() => window.__plakat!.store.getState().selectedIds)).toEqual([img.id]);

  // --- crop: enter crop mode, drag the bottom-right handle inwards, apply ----------------------
  const props = page.getByRole('complementary');
  await props.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__plakat!.controller.getCropState() !== null)).toBe(true);
  const crop = (await page.evaluate(() => window.__plakat!.controller.getCropState()!.rect))!;
  const from = await pageToClient(page, pageId, { x: img.x + crop.x + crop.width, y: img.y + crop.y + crop.height });
  const to = await pageToClient(page, pageId, { x: img.x + crop.x + crop.width * 0.6, y: img.y + crop.y + crop.height * 0.6 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const resized = await page.evaluate(() => window.__plakat!.controller.getCropState()!.rect);
  expect(resized.width).toBeLessThan(crop.width * 0.8);
  await props.getByRole('button', { name: 'Done cropping' }).click();
  await expect.poll(async () => ((await getDocument(page)).pages[0]!.elements.find((e) => e.id === img.id) as ImageElement).crop).not.toBeNull();
  doc = await getDocument(page);
  const cropped = doc.pages[0]!.elements.find((e) => e.id === img.id) as ImageElement;
  expect(cropped.width).toBeCloseTo(img.width, 6); // crop keeps the box
  expect(cropped.crop!.width).toBeLessThan(1200 * 0.8);

  // --- filters through the Adjust sliders and a toggle ----------------------------------------
  await props.getByRole('slider', { name: 'Brightness' }).fill('25');
  await props.getByRole('slider', { name: 'Blur' }).fill('12');
  const sepia = props.getByRole('switch', { name: 'Sepia' });
  await sepia.locator('xpath=ancestor::label[1]').click();
  await expect(sepia).toBeChecked();
  await expect
    .poll(async () => ((await getDocument(page)).pages[0]!.elements.find((e) => e.id === img.id) as ImageElement).filters)
    .toMatchObject({ brightness: 25, blur: 12, sepia: true });

  // --- non-100% zoom, then snapshot vs. real download -------------------------------------------
  await page.evaluate(() => window.__plakat!.store.getState().actions.setZoom(0.63));
  await page.evaluate(() => window.__plakat!.ready());
  for (const scale of ['2x', '1x'] as const) {
    const snapshot = await snapshotPage(page, pageId, scale);
    const download = await exportViaDialog(page, { format: 'png', scale });
    const r = comparePngs(snapshot, download.bytes);
    expect({ width: r.width, height: r.height }).toEqual(scale === '2x' ? { width: 2160, height: 2160 } : { width: 1080, height: 1080 });
    expect(r.diff, `pixelmatch diff at ${scale}`).toBe(0);
    expect(r.bytesEqual).toBe(true);
  }
  expect(errors).toEqual([]);
});
