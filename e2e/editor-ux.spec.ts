/**
 * Editor UX regressions: inline text survives a reload, shortcuts work while a panel
 * slider has focus, the system clipboard (external text, repeated pastes, no JSON in
 * text/plain), and the "Use template" fill form → Replace image → export = snapshot.
 */
import { expect, test } from '@playwright/test';
import type { ImageElement, PlakatDocument, TextElement } from '@plakat/schema';
import {
  captureDownload,
  comparePngs,
  createDesignFromPreset,
  createDesignFromTemplate,
  exportViaDialog,
  getDocument,
  makeTestPng,
  openShareMenu,
  snapshotPage,
  trackPageErrors,
  waitForEditor,
  waitForSaved,
} from './helpers.ts';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const elementsOf = (doc: PlakatDocument) => doc.pages[0]!.elements;

test('text typed in the inline editor survives a reload without leaving the editor', async ({ page }) => {
  const errors = trackPageErrors(page);
  await createDesignFromPreset(page, 'Instagram post');
  await page.keyboard.press('t');
  const editor = page.locator('textarea[data-plakat-text-editor]');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Important headline');
  // Still editing: the draft is committed while typing and autosaved.
  await expect.poll(async () => elementsOf(await getDocument(page)).map((e) => (e as TextElement).content)).toEqual(['Important headline']);
  expect(await page.evaluate(() => window.__plakat!.store.getState().textEditingId)).not.toBeNull();
  await waitForSaved(page);
  await page.reload();
  await waitForEditor(page);
  expect(elementsOf(await getDocument(page)).map((e) => (e as TextElement).content)).toEqual(['Important headline']);
  expect(errors).toEqual([]);
});

test('undo and delete work while a properties slider has focus', async ({ page }) => {
  const errors = trackPageErrors(page);
  await createDesignFromPreset(page, 'Instagram post');
  await page.keyboard.press('r');
  const slider = page.getByRole('complementary').getByRole('slider', { name: 'Opacity' });
  await slider.focus();
  await slider.press('ArrowLeft'); // native slider behavior: opacity 0.99, no nudge
  await expect.poll(async () => elementsOf(await getDocument(page))[0]!.opacity).toBeLessThan(1);
  const x = elementsOf(await getDocument(page))[0]!.x;
  await expect(slider).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => elementsOf(await getDocument(page))[0]!.opacity).toBe(1);
  expect(elementsOf(await getDocument(page))[0]!.x).toBe(x);
  await page.keyboard.press('Backspace');
  await expect.poll(async () => elementsOf(await getDocument(page)).length).toBe(0);
  expect(errors).toEqual([]);
});

test('clipboard: repeated pastes cascade, text/plain carries no JSON, external text becomes a text element', async ({ page }) => {
  const errors = trackPageErrors(page);
  await createDesignFromPreset(page, 'Instagram post');
  await page.keyboard.press('r');
  const [rect] = elementsOf(await getDocument(page));
  await page.keyboard.press('ControlOrMeta+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => elementsOf(await getDocument(page)).length).toBe(4);
  const positions = elementsOf(await getDocument(page)).map((e) => [e.x - rect!.x, e.y - rect!.y]);
  expect(positions).toEqual([
    [0, 0],
    [16, 16],
    [32, 32],
    [48, 48],
  ]);

  // Something copied in another app wins over the (now stale) internal clipboard.
  await page.evaluate(() => navigator.clipboard.writeText('Hello from another app'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => elementsOf(await getDocument(page)).length).toBe(5);
  const last = elementsOf(await getDocument(page)).at(-1)!;
  expect(last).toMatchObject({ type: 'text', content: 'Hello from another app' });
  expect(errors).toEqual([]);
});

test('Use template fill form → Replace image → export 1x = snapshot; the design file has no unused assets', async ({ page }) => {
  const errors = trackPageErrors(page);
  await createDesignFromTemplate(page, 'Product launch', async (dialog) => {
    // Required fields block "Create design" until they are filled.
    await dialog.getByRole('button', { name: 'Create design' }).click();
    await expect(dialog.getByText('Required').first()).toBeVisible();
    const headline = dialog.getByLabel(/^Headline/);
    await headline.fill('A headline that is far too long');
    await expect(dialog.getByText('At most 22 characters')).toBeVisible();
    await headline.fill('Spring drop');
    await dialog.getByLabel('Image for Product photo').setInputFiles({ name: 'fill-photo.png', mimeType: 'image/png', buffer: makeTestPng(900, 900) });
    await expect(dialog.getByRole('button', { name: 'Choose another image' })).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Create design' }).click();
  });
  let doc = await getDocument(page);
  expect(doc.kind).toBe('design');
  expect(elementsOf(doc).some((e) => e.type === 'text' && e.content === 'Spring drop')).toBe(true);
  const photo = elementsOf(doc).find((e): e is ImageElement => e.type === 'image' && doc.assets[e.assetId]!.name === 'fill-photo')!;
  expect(photo, 'the image slot was filled').toBeTruthy();
  expect(doc.assets[photo.assetId]!.src).toMatch(/^\/uploads\//);

  // --- Replace image through the properties panel ------------------------------------------
  await page.evaluate((id) => window.__plakat!.store.getState().actions.select([id]), photo.id);
  await page.getByLabel('Choose a replacement image').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: makeTestPng(640, 480) });
  await expect.poll(async () => (await getDocument(page)).pages[0]!.elements.find((e) => e.id === photo.id) as ImageElement).not.toMatchObject({ assetId: photo.assetId });
  doc = await getDocument(page);
  const pageId = doc.pages[0]!.id;
  const snap = await snapshotPage(page, pageId, '1x');
  const png = await exportViaDialog(page, { format: 'png', scale: '1x' });
  const cmp = comparePngs(snap, png.bytes);
  expect(cmp.diff).toBe(0);

  // --- the portable file only bundles assets a page uses --------------------------------------
  const menu = await openShareMenu(page);
  const file = await captureDownload(page, () => menu.getByRole('menuitem', { name: /Download design file/ }).click());
  const portable = JSON.parse(file.bytes.toString('utf8')) as PlakatDocument;
  const used = new Set(portable.pages.flatMap((p) => [...(p.background.image ? [p.background.image.assetId] : []), ...p.elements.flatMap((e) => (e.type === 'image' ? [e.assetId] : []))]));
  expect(Object.keys(portable.assets).sort()).toEqual([...used].sort());
  expect(Object.values(portable.assets).some((a) => a.name === 'fill-photo')).toBe(false);
  expect(errors).toEqual([]);
});
