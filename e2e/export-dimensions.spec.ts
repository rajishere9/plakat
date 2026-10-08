/**
 * (c) Export dimensions through the real export dialog (render-export-pipeline.md §4.1,
 * §5, P-11): PNG and JPG at 1x / 2x / print match the §4.1 table exactly; PDF has the
 * right page count, page size in pt and orientation; a multi-page PNG export is a ZIP
 * with one correctly sized `<slug>-NN.png` per page.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  createDesignFromPreset,
  decodePng,
  exportViaDialog,
  getDocument,
  jpegSize,
  pngSize,
  readPdf,
  readStoredZip,
  trackPageErrors,
} from './helpers.ts';

type Scale = '1x' | '2x' | 'print';

interface Case {
  preset: string;
  title: string;
  slug: string;
  dims: Record<Scale, [number, number]>;
  pdf: { width: number; height: number; orientation: 'portrait' | 'landscape' } | null;
}

// §4.1 "Expected pixel dimensions" and §5 PDF page sizes.
const CASES: Case[] = [
  {
    preset: 'Instagram post',
    title: 'Dims Instagram',
    slug: 'dims-instagram',
    dims: { '1x': [1080, 1080], '2x': [2160, 2160], print: [3375, 3375] },
    pdf: null,
  },
  {
    preset: 'YouTube thumbnail',
    title: 'Dims YouTube',
    slug: 'dims-youtube',
    dims: { '1x': [1280, 720], '2x': [2560, 1440], print: [4000, 2250] },
    pdf: { width: 960, height: 540, orientation: 'landscape' },
  },
  {
    preset: 'A4 poster',
    title: 'Dims A4',
    slug: 'dims-a4',
    dims: { '1x': [794, 1123], '2x': [1587, 2245], print: [2480, 3508] },
    pdf: { width: 595.28, height: 841.89, orientation: 'portrait' },
  },
];

/** New design from a preset, titled, with a full-bleed shape so there is content. */
async function setUp(page: Page, c: Case): Promise<void> {
  await createDesignFromPreset(page, c.preset);
  const title = page.getByRole('textbox', { name: 'Design title' });
  await title.fill(c.title);
  await title.press('Enter');
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Elements' }).click();
  await page.getByRole('button', { name: 'Add circle' }).click();
  await expect.poll(async () => (await getDocument(page)).meta.title).toBe(c.title);
}

for (const c of CASES) {
  test(`${c.preset}: PNG and JPG at 1x / 2x / print${c.pdf ? ', PDF' : ''}`, async ({ page }) => {
    const errors = trackPageErrors(page);
    await setUp(page, c);
    const dialogDims = page.getByTestId('export-dimensions');

    for (const scale of ['1x', '2x', 'print'] as const) {
      const [w, h] = c.dims[scale];
      const png = await exportViaDialog(page, { format: 'png', scale });
      expect(png.filename).toBe(`${c.slug}.png`);
      expect(pngSize(png.bytes), `PNG ${scale}`).toEqual({ width: w, height: h });
      expect(decodePng(png.bytes).width).toBe(w); // decodes cleanly

      const jpg = await exportViaDialog(page, { format: 'jpg', scale });
      expect(jpg.filename).toBe(`${c.slug}.jpg`);
      expect(jpegSize(jpg.bytes), `JPG ${scale}`).toEqual({ width: w, height: h });
    }
    await expect(dialogDims).toHaveCount(0); // dialog closed after each download

    if (c.pdf) {
      const pdf = await exportViaDialog(page, { format: 'pdf', scale: 'print' });
      expect(pdf.filename).toBe(`${c.slug}.pdf`);
      const info = readPdf(pdf.bytes);
      expect(info.count).toBe(1);
      expect(info.pages).toHaveLength(1);
      expect(info.images).toBe(1);
      const [x0, y0, x1, y1] = info.pages[0]!.mediaBox;
      expect([x0, y0]).toEqual([0, 0]);
      expect(x1 * info.pages[0]!.userUnit).toBeCloseTo(c.pdf.width, 1);
      expect(y1 * info.pages[0]!.userUnit).toBeCloseTo(c.pdf.height, 1);
      expect(x1 > y1 ? 'landscape' : 'portrait').toBe(c.pdf.orientation);
    }
    expect(errors).toEqual([]);
  });
}

test('the dialog shows the §4.1 pixel size before downloading', async ({ page }) => {
  await setUp(page, CASES[2]!);
  await page.locator('.topbar').getByRole('button', { name: 'Share' }).click();
  await page.getByRole('menuitem', { name: /Download PNG, JPG or PDF/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Download' });
  for (const [scale, label] of [['1x', '1×'], ['2x', '2×'], ['print', 'Print (300 dpi)']] as const) {
    await dialog.getByText(label, { exact: true }).click();
    const [w, h] = CASES[2]!.dims[scale];
    await expect(dialog.getByTestId('export-dimensions')).toContainText(`${w} × ${h} px`);
  }
});

test('multi-page: PNG export is a ZIP of numbered pages, PDF has one page per page', async ({ page }) => {
  const errors = trackPageErrors(page);
  const c = CASES[1]!; // YouTube thumbnail (landscape)
  await setUp(page, c);
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Pages' }).click();
  await page.getByRole('button', { name: 'Add page', exact: true }).click();
  await page.getByRole('button', { name: 'Add page', exact: true }).click();
  await expect.poll(async () => (await getDocument(page)).pages.length).toBe(3);

  const zip = await exportViaDialog(page, { format: 'png', scale: '2x', pages: 'all' });
  expect(zip.filename).toBe(`${c.slug}.zip`);
  const entries = readStoredZip(zip.bytes);
  expect(entries.map((e) => e.name)).toEqual([`${c.slug}-01.png`, `${c.slug}-02.png`, `${c.slug}-03.png`]);
  for (const e of entries) expect(pngSize(e.data)).toEqual({ width: 2560, height: 1440 });

  const subset = await exportViaDialog(page, { format: 'jpg', scale: '1x', pages: '2-3' });
  expect(subset.filename).toBe(`${c.slug}.zip`);
  const jpgs = readStoredZip(subset.bytes);
  expect(jpgs.map((e) => e.name)).toEqual([`${c.slug}-02.jpg`, `${c.slug}-03.jpg`]);
  for (const e of jpgs) expect(jpegSize(e.data)).toEqual({ width: 1280, height: 720 });

  const pdf = await exportViaDialog(page, { format: 'pdf', scale: '1x', pages: 'all' });
  expect(pdf.filename).toBe(`${c.slug}.pdf`);
  const info = readPdf(pdf.bytes);
  expect(info.count).toBe(3);
  expect(info.pages).toHaveLength(3);
  for (const p of info.pages) {
    expect(p.mediaBox[2]).toBeCloseTo(960, 1);
    expect(p.mediaBox[3]).toBeCloseTo(540, 1);
  }
  expect(errors).toEqual([]);
});
