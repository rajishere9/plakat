/**
 * (a) Smoke: home loads, create an Instagram post, add text and a shape, undo/redo,
 * the layers panel reflects (and changes) the stacking order, autosave persists across
 * a reload.
 */
import { expect, test } from '@playwright/test';
import { createDesignFromPreset, getDocument, trackPageErrors, waitForEditor, waitForSaved } from './helpers.ts';

test('home → new Instagram post → edit → undo/redo → layers → autosave survives reload', async ({ page }) => {
  const errors = trackPageErrors(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What will you design today?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
  // Built-in templates are seeded by the server and listed in the gallery.
  await expect(page.getByRole('button', { name: 'Use template: Quote card' })).toBeVisible();

  const id = await createDesignFromPreset(page, 'Instagram post');
  let doc = await getDocument(page);
  expect(doc.size).toMatchObject({ width: 1080, height: 1080 });
  expect(doc.pages).toHaveLength(1);
  expect(doc.pages[0]!.elements).toHaveLength(0);

  // --- add a heading (Text panel) and a rectangle (Elements panel) ---------------------
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('button', { name: 'Text' }).click();
  await page.getByRole('button', { name: /Add a heading/ }).click();
  await rail.getByRole('button', { name: 'Elements' }).click();
  await page.getByRole('button', { name: 'Add rectangle' }).click();

  doc = await getDocument(page);
  const [text, rect] = doc.pages[0]!.elements;
  expect(text?.type).toBe('text');
  expect(rect?.type).toBe('shape');

  // --- undo / redo through the top bar and the keyboard --------------------------------
  const topbar = page.locator('.topbar');
  await topbar.getByRole('button', { name: /^Undo/ }).click();
  expect((await getDocument(page)).pages[0]!.elements.map((e) => e.id)).toEqual([text!.id]);
  await topbar.getByRole('button', { name: /^Redo/ }).click();
  expect((await getDocument(page)).pages[0]!.elements.map((e) => e.id)).toEqual([text!.id, rect!.id]);

  await page.locator('[data-plakat-stage]').click({ position: { x: 5, y: 5 } }); // focus the canvas, deselect
  await page.keyboard.press('ControlOrMeta+z');
  expect((await getDocument(page)).pages[0]!.elements).toHaveLength(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect((await getDocument(page)).pages[0]!.elements).toHaveLength(2);

  // --- layers panel: topmost first; Alt+ArrowDown moves a layer down --------------------
  await rail.getByRole('button', { name: 'Layers' }).click();
  const rows = page.locator('ul.layers > li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-layer-id', rect!.id);
  await expect(rows.nth(1)).toHaveAttribute('data-layer-id', text!.id);

  await rows.nth(0).locator('.layer__main').click();
  expect(await page.evaluate(() => window.__plakat!.store.getState().selectedIds)).toEqual([rect!.id]);
  await rows.nth(0).locator('.layer__main').press('Alt+ArrowDown');
  await expect(rows.nth(0)).toHaveAttribute('data-layer-id', text!.id);
  await expect(rows.nth(1)).toHaveAttribute('data-layer-id', rect!.id);
  expect((await getDocument(page)).pages[0]!.elements.map((e) => e.id)).toEqual([rect!.id, text!.id]);

  // Undo of the reorder is reflected in the panel too.
  await topbar.getByRole('button', { name: /^Undo/ }).click();
  await expect(rows.nth(0)).toHaveAttribute('data-layer-id', rect!.id);
  await topbar.getByRole('button', { name: /^Redo/ }).click();
  await expect(rows.nth(0)).toHaveAttribute('data-layer-id', text!.id);

  // --- autosave, then reload ---------------------------------------------------------------
  await waitForSaved(page);
  const saved = await getDocument(page);
  await page.reload();
  await waitForEditor(page);
  expect(page.url()).toContain(`#/design/${id}`);
  const reloaded = await getDocument(page);
  expect(reloaded.pages[0]!.elements.map((e) => e.id)).toEqual([rect!.id, text!.id]);
  expect(reloaded.pages[0]!.elements).toEqual(saved.pages[0]!.elements);

  // Back to home: the design is listed, with a rendered thumbnail.
  await page.locator('.topbar').getByRole('button', { name: 'Back to home' }).click();
  const card = page.locator(`a[href="#/design/${encodeURIComponent(id)}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('img')).toHaveAttribute('src', new RegExp(`/api/projects/${id}/thumbnail\\?v=`));
  await expect.poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(480);

  expect(errors).toEqual([]);
});
