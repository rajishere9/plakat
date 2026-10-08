/**
 * Shared helpers for the Plakat e2e specs: editor readiness, canvas coordinates,
 * driving the export dialog and decoding what it downloads (PNG, JPG, PDF, ZIP).
 */
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, type Download, type Locator, type Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { PlakatDocument } from '@plakat/schema';
import { readStoredZip } from '../packages/renderer/src/zip.ts';

export { readStoredZip };

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** Fails the test on uncaught page errors; returns the collected console errors. */
export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Waits for the workspace test hook and its readiness barrier (fonts, images, draw). */
export async function waitForEditor(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__plakat, undefined, { timeout: 30_000 });
  await page.evaluate(() => window.__plakat!.ready());
}

export async function getDocument(page: Page): Promise<PlakatDocument> {
  return page.evaluate(() => window.__plakat!.getDocument());
}

/** The design id from a `#/design/:id` URL. */
export function designIdFromUrl(url: string): string {
  const m = /#\/design\/([^/?#]+)/.exec(url);
  if (!m) throw new Error(`not an editor URL: ${url}`);
  return decodeURIComponent(m[1]!);
}

/** Home → preset card → editor ready. Returns the new design id. */
export async function createDesignFromPreset(page: Page, presetLabel: RegExp | string): Promise<string> {
  await page.goto('/');
  await page.locator('.preset-card', { hasText: presetLabel }).first().click();
  await page.waitForURL(/#\/design\//);
  await waitForEditor(page);
  return designIdFromUrl(page.url());
}

/** Home → template card → new design from the template → editor ready. */
export async function createDesignFromTemplate(page: Page, title: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: `Use template: ${title}`, exact: true }).click();
  await page.waitForURL(/#\/design\//);
  await waitForEditor(page);
  return designIdFromUrl(page.url());
}

/** Waits for autosave to settle ("Saved") after the last edit. */
export async function waitForSaved(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__plakat!.store.getState().saveStatus), { timeout: 60_000 })
    .toBe('saved');
  await expect(page.locator('.topbar').getByRole('status')).toHaveText(/Saved/);
}

/** Converts a page-space point to page (viewport) CSS coordinates for mouse events. */
export async function pageToClient(page: Page, pageId: string, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const local = await page.evaluate(({ pageId, p }) => window.__plakat!.controller.pageToScreenPoint(pageId, p), { pageId, p });
  if (!local) throw new Error(`page ${pageId} not laid out`);
  const box = await page.locator('[data-plakat-stage]').boundingBox();
  if (!box) throw new Error('stage not visible');
  return { x: box.x + local.x, y: box.y + local.y };
}

/** Client coordinates of an element's center. */
export async function elementCenter(page: Page, elementId: string): Promise<{ x: number; y: number }> {
  const doc = await getDocument(page);
  for (const pg of doc.pages) {
    const el = pg.elements.find((e) => e.id === elementId);
    if (el) return pageToClient(page, pg.id, { x: el.x + el.width / 2, y: el.y + el.height / 2 });
  }
  throw new Error(`element ${elementId} not found`);
}

/** The editor's own PageScene for `pageId`, rasterized at `scale` (§6.2), as PNG bytes. */
export async function snapshotPage(page: Page, pageId: string, scale: number | '1x' | '2x' | 'print'): Promise<Buffer> {
  await page.evaluate(() => window.__plakat!.ready());
  const b64 = await page.evaluate(({ pageId, scale }) => window.__plakat!.snapshotContentLayerBase64(pageId, scale), { pageId, scale });
  return Buffer.from(b64, 'base64');
}

// ---------------------------------------------------------------------------
// Downloads and the export dialog
// ---------------------------------------------------------------------------

export interface Downloaded {
  filename: string;
  bytes: Buffer;
}

export async function readDownload(download: Download): Promise<Downloaded> {
  const file = await download.path();
  return { filename: download.suggestedFilename(), bytes: await readFile(file) };
}

/** Runs `trigger` and returns the download it starts. */
export async function captureDownload(page: Page, trigger: () => Promise<unknown>): Promise<Downloaded> {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()]);
  return readDownload(download);
}

export async function openShareMenu(page: Page): Promise<Locator> {
  await page.locator('.topbar').getByRole('button', { name: 'Share' }).click();
  const menu = page.getByRole('menu', { name: 'Share and export' });
  await expect(menu).toBeVisible();
  return menu;
}

export interface ExportChoice {
  format: 'png' | 'jpg' | 'pdf';
  scale: '1x' | '2x' | 'print';
  /** Multi-page designs only. Default: whatever the dialog preselects (all pages). */
  pages?: 'all' | 'current' | string;
}

/** Clicks the <label> wrapping a (visually styled) radio input, like a user would. */
async function pickRadio(input: Locator): Promise<void> {
  if (!(await input.isChecked())) await input.locator('xpath=ancestor::label[1]').click();
  await expect(input).toBeChecked();
}

/** Share → Download… → choose format / scale / pages → Download; returns the file. */
export async function exportViaDialog(page: Page, choice: ExportChoice): Promise<Downloaded> {
  const menu = await openShareMenu(page);
  await menu.getByRole('menuitem', { name: /Download PNG, JPG or PDF/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Download' });
  await expect(dialog).toBeVisible();
  await pickRadio(dialog.locator(`input[name="export-format"][value="${choice.format}"]`));
  await pickRadio(dialog.locator(`input[name="export-scale"][value="${choice.scale}"]`));
  if (choice.pages === 'all') await pickRadio(dialog.getByRole('radio', { name: /^All pages/ }));
  else if (choice.pages === 'current') await pickRadio(dialog.getByRole('radio', { name: /^Current page/ }));
  else if (choice.pages) await dialog.getByRole('textbox', { name: 'Page range' }).fill(choice.pages);
  const result = await captureDownload(page, () => dialog.getByRole('button', { name: 'Download', exact: true }).click());
  await expect(dialog).toBeHidden();
  return result;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export function decodePng(bytes: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(bytes));
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(bytes);
  expect(b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Width/height from the first SOFn marker of a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(bytes);
  expect(b[0] === 0xff && b[1] === 0xd8).toBe(true);
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no SOF marker in JPEG');
}

/** Pixel-exact comparison (pixelmatch threshold 0) plus raw byte equality. */
export function comparePngs(a: Uint8Array, b: Uint8Array): { width: number; height: number; diff: number; bytesEqual: boolean } {
  const pa = decodePng(a);
  const pb = decodePng(b);
  expect({ width: pa.width, height: pa.height }).toEqual({ width: pb.width, height: pb.height });
  const diff = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold: 0 });
  const bytesEqual = Buffer.compare(pa.data, pb.data) === 0;
  if (!bytesEqual && process.env.PLAKAT_E2E_DEBUG) {
    let n = 0;
    const samples: string[] = [];
    for (let i = 0; i < pa.data.length; i += 4) {
      if (pa.data.readUInt32BE(i) !== pb.data.readUInt32BE(i)) {
        n++;
        if (samples.length < 12) {
          const px = i / 4;
          samples.push(`(${px % pa.width},${Math.floor(px / pa.width)}) ${[...pa.data.subarray(i, i + 4)]} vs ${[...pb.data.subarray(i, i + 4)]}`);
        }
      }
    }
    const dir = process.env.PLAKAT_E2E_DEBUG;
    if (dir.length > 1) {
      const stamp = Date.now();
      writeFileSync(`${dir}/cmp-${stamp}-a.png`, Buffer.from(a));
      writeFileSync(`${dir}/cmp-${stamp}-b.png`, Buffer.from(b));
    }
    console.log(`[comparePngs] ${pa.width}x${pa.height}: ${n} differing pixels; e.g.\n  ${samples.join('\n  ')}`);
  }
  return { width: pa.width, height: pa.height, diff, bytesEqual };
}

export interface PdfPageInfo {
  mediaBox: [number, number, number, number];
  userUnit: number;
}

/** Minimal reader for jsPDF output (uncompressed object dictionaries). */
export function readPdf(bytes: Uint8Array): { pages: PdfPageInfo[]; images: number; count: number } {
  const src = Buffer.from(bytes).toString('latin1');
  expect(src.startsWith('%PDF-')).toBe(true);
  expect(src.trimEnd().endsWith('%%EOF')).toBe(true);
  const dicts = src.replace(/stream\r?\n[\s\S]*?endstream/g, 'stream endstream');
  const pages: PdfPageInfo[] = [];
  const objRe = /\d+ 0 obj\s*<<([\s\S]*?)>>\s*(?:stream endstream\s*)?endobj/g;
  let m: RegExpExecArray | null;
  let images = 0;
  let count = -1;
  while ((m = objRe.exec(dicts))) {
    const body = m[1]!;
    if (/\/Type\s*\/Page(?![s\w])/.test(body)) {
      const mb = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(body);
      if (!mb) throw new Error('page without MediaBox');
      const uu = /\/UserUnit\s+([\d.]+)/.exec(body);
      pages.push({ mediaBox: [Number(mb[1]), Number(mb[2]), Number(mb[3]), Number(mb[4])], userUnit: uu ? Number(uu[1]) : 1 });
    }
    if (/\/Type\s*\/Pages/.test(body)) count = Number(/\/Count\s+(\d+)/.exec(body)?.[1] ?? -1);
    if (/\/Subtype\s*\/Image/.test(body)) images++;
  }
  return { pages, images, count };
}

/** A deterministic, colorful RGB test photo (PNG) with a distinct pattern per quadrant. */
export function makeTestPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const checker = ((x >> 5) + (y >> 5)) % 2 === 0;
      png.data[i] = Math.round((x / width) * 255);
      png.data[i + 1] = Math.round((y / height) * 255);
      png.data[i + 2] = checker ? 200 : 60;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
