/**
 * (d) Template flow: instantiate a built-in template, edit a text slot inline on the
 * canvas, save the design as a new template, download that template's portable
 * .plakat.json file, re-import the file, and start a design from the imported copy.
 */
import { expect, test } from '@playwright/test';
import type { PlakatDocument, TextElement } from '@plakat/schema';
import { captureDownload, createDesignFromTemplate, elementCenter, getDocument, openShareMenu, trackPageErrors, waitForEditor } from './helpers.ts';

const NEW_QUOTE = 'Glow Serum 2.0'; // within the headline slot's maxLength (22)

test('template → edit slot text → save as template → download file → re-import', async ({ page, request }, testInfo) => {
  const errors = trackPageErrors(page);
  const templateTitle = `E2E quote ${testInfo.workerIndex}-${Date.now()}`;

  // --- instantiate the built-in "Product launch" (text + image slots) --------------------------
  const builtIn = (await (await request.get('/api/templates/tpl_instagram-post_product-launch')).json()) as { document: PlakatDocument; builtIn: boolean };
  expect(builtIn.builtIn).toBe(true);
  const quoteSlot = builtIn.document.template!.slots.find((s) => s.kind === 'text' && s.label === 'Headline')!;
  expect(quoteSlot).toBeTruthy();
  expect(Object.keys(builtIn.document.assets).length).toBeGreaterThan(0);

  await createDesignFromTemplate(page, 'Product launch');
  let doc = await getDocument(page);
  expect(doc.kind).toBe('design');
  const original = builtIn.document.pages[0]!.elements.find((e) => e.id === quoteSlot.targets[0]) as TextElement;
  const quote = doc.pages[0]!.elements.find((e): e is TextElement => e.type === 'text' && e.content === original.content)!;
  expect(quote, 'the slot target was instantiated').toBeTruthy();

  // --- edit the slot's text inline: double-click, replace, Mod+Enter ---------------------------
  const center = await elementCenter(page, quote.id);
  await page.mouse.dblclick(center.x, center.y);
  const editor = page.locator('textarea');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(NEW_QUOTE);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(editor).toBeHidden();
  doc = await getDocument(page);
  expect((doc.pages[0]!.elements.find((e) => e.id === quote.id) as TextElement).content).toBe(NEW_QUOTE);
  await page.evaluate(() => window.__plakat!.ready());

  // --- save as template (server) -----------------------------------------------------------
  let menu = await openShareMenu(page);
  await menu.getByRole('menuitem', { name: /Save as template/ }).click();
  let dialog = page.getByRole('dialog', { name: 'Save as template' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Template name' }).fill(templateTitle);
  await expect(dialog.getByRole('checkbox', { name: /^Editable: / }).first()).toBeChecked();
  await dialog.getByRole('button', { name: 'Save to templates' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Saved “${templateTitle}” to your templates`)).toBeVisible();

  const listed = (await (await request.get(`/api/templates?q=${encodeURIComponent(templateTitle)}`)).json()) as { items: { id: string; title: string; builtIn: boolean; slotCount: number }[] };
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]).toMatchObject({ title: templateTitle, builtIn: false });
  expect(listed.items[0]!.slotCount).toBeGreaterThan(0);
  const savedId = listed.items[0]!.id;
  const saved = (await (await request.get(`/api/templates/${savedId}`)).json()) as { document: PlakatDocument };
  expect(saved.document.kind).toBe('template');
  const savedQuote = saved.document.pages[0]!.elements.find((e): e is TextElement => e.type === 'text' && e.content === NEW_QUOTE);
  expect(savedQuote).toBeTruthy();
  expect(saved.document.template!.slots.some((s) => s.targets.includes(savedQuote!.id))).toBe(true);

  // The open design is unchanged (still a design).
  expect((await getDocument(page)).kind).toBe('design');

  // --- the dialog can also download a template file directly (client-side bundling) ---------
  menu = await openShareMenu(page);
  await menu.getByRole('menuitem', { name: /Save as template/ }).click();
  dialog = page.getByRole('dialog', { name: 'Save as template' });
  await dialog.getByRole('textbox', { name: 'Template name' }).fill(templateTitle);
  const local = await captureDownload(page, () => dialog.getByRole('button', { name: 'Download template file' }).click());
  expect(local.filename).toMatch(/\.plakat\.json$/);
  const localDoc = JSON.parse(local.bytes.toString('utf8')) as PlakatDocument;
  expect(localDoc.kind).toBe('template');
  expect(Object.values(localDoc.assets).every((a) => a.src.startsWith('data:'))).toBe(true);

  // --- download the saved template's portable file from the gallery ---------------------------
  await page.locator('.topbar').getByRole('button', { name: 'Back to home' }).click();
  await page.waitForURL((u) => !u.hash.includes('/design/'));
  await page.getByRole('button', { name: `More actions for ${templateTitle}` }).click();
  const file = await captureDownload(page, () => page.getByRole('menuitem', { name: 'Download template file' }).click());
  expect(file.filename).toMatch(/\.plakat\.json$/);
  const portable = JSON.parse(file.bytes.toString('utf8')) as PlakatDocument;
  expect(portable.kind).toBe('template');
  expect(portable.meta.title).toBe(templateTitle);
  expect(Object.keys(portable.assets).length).toBeGreaterThan(0);
  expect(Object.values(portable.assets).every((a) => a.src.startsWith('data:'))).toBe(true); // self-contained
  expect(portable.pages[0]!.elements.some((e) => e.type === 'text' && e.content === NEW_QUOTE)).toBe(true);

  // --- re-import it through "Import file" ------------------------------------------------------
  await page.getByLabel('Choose a .plakat.json file to import').setInputFiles({
    name: file.filename,
    mimeType: 'application/json',
    buffer: file.bytes,
  });
  await expect(page.getByText(`Imported template “${templateTitle}”`)).toBeVisible();
  const after = (await (await request.get(`/api/templates?q=${encodeURIComponent(templateTitle)}`)).json()) as { items: { id: string }[] };
  expect(after.items).toHaveLength(2);
  const importedId = after.items.map((i) => i.id).find((id) => id !== savedId)!;
  const imported = (await (await request.get(`/api/templates/${importedId}`)).json()) as { document: PlakatDocument };
  expect(imported.document.pages[0]!.elements.some((e) => e.type === 'text' && e.content === NEW_QUOTE)).toBe(true);
  // Embedded images were moved into this server's uploads on import.
  expect(Object.values(imported.document.assets).every((a) => a.src.startsWith('/uploads/'))).toBe(true);
  expect(imported.document.template!.slots.length).toBe(saved.document.template!.slots.length);

  // --- use the imported template ------------------------------------------------------------------
  await expect(page.getByRole('button', { name: `Use template: ${templateTitle}` })).toHaveCount(2);
  await page.getByRole('button', { name: `Use template: ${templateTitle}` }).first().click();
  await page.waitForURL(/#\/design\//);
  await waitForEditor(page);
  const fromImport = await getDocument(page);
  expect(fromImport.kind).toBe('design');
  expect(fromImport.pages[0]!.elements.some((e) => e.type === 'text' && e.content === NEW_QUOTE)).toBe(true);
  expect(await page.evaluate(() => window.__plakat!.getStatus())).toMatchObject({ missingAssets: [], missingFonts: [] });

  expect(errors).toEqual([]);
});
