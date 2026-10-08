/**
 * Brand kit logos in a real browser: create a kit on an EU business card, upload a logo
 * into it, insert the logo into the design, check it is drawn (not the missing-image
 * placeholder), survives a reload, and exports pixel-identical to the editor. Also
 * checks the keyboard shortcuts dialog opens with `?`.
 */
import { expect, test } from '@playwright/test';
import type { ImageElement } from '@plakat/schema';
import { comparePngs, createDesignFromPreset, decodePng, exportViaDialog, getDocument, makeTestPng, snapshotPage, trackPageErrors, waitForEditor, waitForSaved } from './helpers.ts';

test('brand kit: upload a logo, insert it into an EU business card, reload, export = snapshot', async ({ page, request }) => {
  const errors = trackPageErrors(page);
  await createDesignFromPreset(page, /85\s*×\s*55\s*mm/);
  let doc = await getDocument(page);
  expect(doc.size).toMatchObject({ presetId: 'business-card-eu', physical: { width: 85, height: 55, unit: 'mm' } });

  // --- create a kit and upload a logo -------------------------------------------------------
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Brand' }).click();
  await page.getByRole('button', { name: 'Create brand kit' }).click();
  await expect(page.getByRole('button', { name: 'Apply brand to design' })).toBeVisible();
  await page.getByLabel('Choose logo files').setInputFiles({ name: 'acme-logo.png', mimeType: 'image/png', buffer: makeTestPng(400, 200) });
  const tile = page.getByRole('button', { name: 'Insert logo acme-logo' });
  await expect(tile).toBeVisible({ timeout: 30_000 });

  // The kit (with its logo asset) is saved on the server.
  await expect
    .poll(async () => {
      const res = await request.get('/api/brand-kits');
      const body = (await res.json()) as { items?: { logos?: unknown[] }[] } | { logos?: unknown[] }[];
      const items = Array.isArray(body) ? body : (body.items ?? []);
      return items.some((k) => (k.logos?.length ?? 0) === 1);
    }, { timeout: 30_000 })
    .toBe(true);

  // --- insert it --------------------------------------------------------------------------------
  await tile.click();
  doc = await getDocument(page);
  const logo = doc.pages[0]!.elements.find((e): e is ImageElement => e.type === 'image')!;
  expect(logo).toBeTruthy();
  expect(logo.objectFit).toBe('contain');
  expect(doc.assets[logo.assetId]).toMatchObject({ width: 400, height: 200, mimeType: 'image/png' });
  expect(doc.assets[logo.assetId]!.src).toMatch(/^\/uploads\/[0-9a-f]{64}\.png$/);
  expect(logo.width).toBeLessThanOrEqual(Math.min(doc.size.width, doc.size.height) * 0.3 + 1e-6);

  // Drawn from the real bitmap: the logo's center has the test image's colors, not white.
  await page.evaluate(() => window.__plakat!.ready());
  const pageId = doc.pages[0]!.id;
  const snap = decodePng(await snapshotPage(page, pageId, '1x'));
  const cx = Math.round(logo.x + logo.width / 2);
  const cy = Math.round(logo.y + logo.height / 2);
  const i = (cy * snap.width + cx) * 4;
  const [r, g, b] = [snap.data[i]!, snap.data[i + 1]!, snap.data[i + 2]!];
  expect(r === 255 && g === 255 && b === 255).toBe(false);

  // --- survives a reload, and the export matches the editor -----------------------------------
  await waitForSaved(page);
  await page.reload();
  await waitForEditor(page);
  doc = await getDocument(page);
  expect(doc.pages[0]!.elements.map((e) => e.id)).toContain(logo.id);
  const snapshot = await snapshotPage(page, pageId, '2x');
  const file = await exportViaDialog(page, { format: 'png', scale: '2x' });
  const cmp = comparePngs(file.bytes, snapshot);
  expect({ width: cmp.width, height: cmp.height }).toEqual({ width: 643, height: 416 });
  expect(cmp.bytesEqual).toBe(true);

  // --- `?` opens the shortcuts help ------------------------------------------------------------
  await page.locator('[data-plakat-stage]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help.getByRole('heading', { name: 'Mouse and canvas' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  expect(errors).toEqual([]);
});
