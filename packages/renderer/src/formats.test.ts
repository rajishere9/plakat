/**
 * Output formats (§5): JPG flattening, PDF page count/size/orientation/userUnit, the STORE
 * ZIP writer, file names, PNG/JPEG density metadata.
 */
import { createTestEnv, decodePng, makeDoc, page, pixelAt, rgba, shape, text } from './test-support.ts';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadImage } from 'canvas';
import { PNG } from 'pngjs';
import { customPageSize, pdfPageLayout, presetToPageSize, type PresetId } from '@plakat/schema';
import { exportDocument, exportPage, flattenOntoWhite, renderPageCanvas } from './export.ts';
import { createZip, crc32, readStoredZip } from './zip.ts';
import { dpiToPixelsPerMetre, readJpegDensity, readPngPhys, setJpegDpi, setPngDpi } from './encode.ts';
import { exportBaseName, pageFileName, pageNumberLabel, slugify } from './filename.ts';

const T = { timeout: 180_000 };
const env = createTestEnv();

function docFor(preset: PresetId | ReturnType<typeof customPageSize>, pages = 1, title = 'Format test') {
  const size = typeof preset === 'string' ? presetToPageSize(preset) : preset;
  return makeDoc(
    size,
    Array.from({ length: pages }, (_, i) =>
      page(`pg_${i + 1}`, [
        shape(`el_r${i}`, 'rect', { x: 0, y: 0, width: size.width / 2, height: size.height / 2, fill: '#ff3b30' }),
        text(`el_t${i}`, { x: 10, y: size.height / 2, width: size.width - 20, height: 30, content: `Page ${i + 1}`, fontSize: 20 }),
      ]),
    ),
    {},
    title,
  );
}

function bytesOf(data: unknown): Uint8Array {
  expect(data).toBeInstanceOf(Uint8Array);
  return data as Uint8Array;
}

// ---------------------------------------------------------------------------
// Minimal PDF reader for the assertions below (jsPDF writes uncompressed object dicts)
// ---------------------------------------------------------------------------

interface PdfPageInfo {
  mediaBox: [number, number, number, number];
  userUnit: number;
}

function readPdfPages(bytes: Uint8Array): { pages: PdfPageInfo[]; images: number; countInTree: number } {
  const src = Buffer.from(bytes).toString('latin1');
  expect(src.startsWith('%PDF-')).toBe(true);
  expect(src.trimEnd().endsWith('%%EOF')).toBe(true);
  // drop stream bodies (binary image data)
  const dicts = src.replace(/stream\r?\n[\s\S]*?endstream/g, 'stream endstream');
  const pages: PdfPageInfo[] = [];
  const objRe = /\d+ 0 obj\s*<<([\s\S]*?)>>\s*(?:stream endstream\s*)?endobj/g;
  let m: RegExpExecArray | null;
  let images = 0;
  let countInTree = -1;
  while ((m = objRe.exec(dicts))) {
    const body = m[1]!;
    if (/\/Type\s*\/Page(?![s\w])/.test(body)) {
      const mb = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(body);
      expect(mb).not.toBeNull();
      const uu = /\/UserUnit\s+([\d.]+)/.exec(body);
      pages.push({ mediaBox: [Number(mb![1]), Number(mb![2]), Number(mb![3]), Number(mb![4])], userUnit: uu ? Number(uu[1]) : 1 });
    }
    if (/\/Type\s*\/Pages/.test(body)) countInTree = Number(/\/Count\s+(\d+)/.exec(body)![1]);
    if (/\/Subtype\s*\/Image/.test(body)) images++;
  }
  return { pages, images, countInTree };
}

describe('JPG (§5)', () => {
  it('flattens transparency onto white; the page colour sits on top', T, async () => {
    const size = customPageSize(200, 100);
    const doc = makeDoc(size, [
      page('pg_1', [shape('el_half', 'rect', { x: 100, y: 0, width: 100, height: 100, fill: '#ff000080' })], { color: null, image: null }),
    ]);
    const r = await renderPageCanvas(doc, 'pg_1', { scale: 1, env });
    const raw = rgba(r.canvas);
    expect(pixelAt(raw, 200, 10, 50)).toEqual([0, 0, 0, 0]); // PNG keeps alpha
    const flat = flattenOntoWhite(r.canvas);
    const fl = rgba(flat);
    expect(pixelAt(fl, 200, 10, 50)).toEqual([255, 255, 255, 255]);
    const [rr, gg, bb, aa] = pixelAt(fl, 200, 150, 50);
    expect(aa).toBe(255);
    expect(rr).toBe(255);
    expect(Math.abs(gg - 127)).toBeLessThanOrEqual(1);
    expect(Math.abs(bb - 127)).toBeLessThanOrEqual(1);
    r.release();

    const jpg = bytesOf(await exportPage(doc, 'pg_1', { format: 'jpg', scale: 1, env }));
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    const img = await loadImage(Buffer.from(jpg));
    expect([img.width, img.height]).toEqual([200, 100]);
    const { createCanvas } = await import('canvas');
    const c = createCanvas(200, 100);
    c.getContext('2d').drawImage(img, 0, 0);
    const d = c.getContext('2d').getImageData(0, 0, 200, 100).data;
    const white = pixelAt(d as unknown as Uint8Array, 200, 20, 50);
    expect(Math.min(...white.slice(0, 3))).toBeGreaterThanOrEqual(250);
  });

  it('print JPG carries a 300 dpi JFIF density; quality is clamped', T, async () => {
    const doc = docFor('business-card');
    const jpg = bytesOf(await exportPage(doc, 'pg_1', { format: 'jpg', scale: 'print', env, quality: 0.1 }));
    expect(readJpegDensity(jpg)).toEqual({ unit: 1, x: 300, y: 300 });
    const img = await loadImage(Buffer.from(jpg));
    expect([img.width, img.height]).toEqual([1050, 600]);
  });
});

describe('PDF (§5, P-10)', () => {
  const cases: [PresetId, number, number, 'portrait' | 'landscape'][] = [
    ['youtube-thumbnail', 960, 540, 'landscape'],
    ['business-card', 252, 144, 'landscape'],
    ['business-card-eu', 240.94, 155.91, 'landscape'],
    ['a4-poster', 595.28, 841.89, 'portrait'],
    ['instagram-post', 810, 810, 'portrait'],
  ];
  for (const [preset, w, h, orientation] of cases) {
    it(`${preset}: one page per document page, ${w} × ${h} pt (${orientation})`, T, async () => {
      const doc = docFor(preset, 2);
      expect(pdfPageLayout(doc.size).orientation).toBe(orientation);
      const res = await exportDocument(doc, { format: 'pdf', scale: preset === 'business-card' ? undefined : '1x', env });
      expect(res.mimeType).toBe('application/pdf');
      expect(res.filename).toBe('format-test.pdf');
      const pdf = readPdfPages(bytesOf(res.data));
      expect(pdf.pages).toHaveLength(2);
      expect(pdf.countInTree).toBe(2);
      for (const p of pdf.pages) {
        expect(p.mediaBox[0]).toBe(0);
        expect(p.mediaBox[1]).toBe(0);
        expect(p.mediaBox[2]).toBeCloseTo(w, 1);
        expect(p.mediaBox[3]).toBeCloseTo(h, 1);
        expect(p.mediaBox[2] > p.mediaBox[3]).toBe(orientation === 'landscape');
        expect(p.userUnit).toBe(1);
      }
      expect(pdf.images).toBeGreaterThanOrEqual(2);
    });
  }

  it('pages above 14 400 pt use an integer /UserUnit', T, async () => {
    const doc = docFor(customPageSize(20_000, 1_000), 1, 'Huge banner');
    const layout = pdfPageLayout(doc.size);
    expect(layout.userUnit).toBe(2);
    const res = await exportDocument(doc, { format: 'pdf', scale: 0.1, env });
    const pdf = readPdfPages(bytesOf(res.data));
    expect(pdf.pages).toHaveLength(1);
    expect(pdf.pages[0]!.userUnit).toBe(2);
    expect(pdf.pages[0]!.mediaBox[2]).toBeCloseTo(7500, 1);
    expect(pdf.pages[0]!.mediaBox[3]).toBeCloseTo(375, 1);
  });
});

describe('multi-page PNG/JPG → STORE ZIP (P-11)', () => {
  it('zips <slug>-NN.png entries that unzip with valid headers and CRCs', T, async () => {
    const doc = docFor('business-card', 3, 'Café Menü 2026!');
    const date = new Date(2026, 9, 8, 12, 34, 56);
    const res = await exportDocument(doc, { format: 'png', scale: '2x', env, date });
    expect(res.filename).toBe('cafe-menu-2026.zip');
    expect(res.mimeType).toBe('application/zip');
    const zip = bytesOf(res.data);
    const entries = readStoredZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['cafe-menu-2026-01.png', 'cafe-menu-2026-02.png', 'cafe-menu-2026-03.png']);
    for (const e of entries) {
      const png = decodePng(e.data);
      expect([png.width, png.height]).toEqual([672, 384]);
      expect(crc32(e.data)).toBe(e.crc);
    }
    // independent sequential walk over the local headers
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let off = 0;
    for (const e of entries) {
      expect(view.getUint32(off, true)).toBe(0x04034b50);
      expect(view.getUint16(off + 8, true)).toBe(0); // STORE
      expect(view.getUint16(off + 6, true) & 0x0800).toBe(0x0800); // UTF-8 names
      expect(view.getUint32(off + 14, true)).toBe(crc32(e.data));
      const n = view.getUint16(off + 26, true);
      const dosTime = view.getUint16(off + 10, true);
      const dosDate = view.getUint16(off + 12, true);
      expect([dosDate >> 9, (dosDate >> 5) & 15, dosDate & 31]).toEqual([2026 - 1980, 10, 8]);
      expect([dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2]).toEqual([12, 34, 56]);
      off += 30 + n + view.getUint32(off + 18, true);
    }
    expect(view.getUint32(off, true)).toBe(0x02014b50);
    // and the system unzip agrees, when available
    let unzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      unzip = false;
    }
    if (unzip) {
      const dir = mkdtempSync(join(tmpdir(), 'plakat-zip-'));
      try {
        writeFileSync(join(dir, 'x.zip'), zip);
        const out = execFileSync('unzip', ['-t', join(dir, 'x.zip')]).toString();
        expect(out).toMatch(/No errors detected/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('a single page exports as one file (with the page number when the document has several)', T, async () => {
    const one = docFor('business-card', 1, 'Solo');
    const r1 = await exportDocument(one, { format: 'png', env });
    expect(r1.filename).toBe('solo.png');
    expect(r1.mimeType).toBe('image/png');
    expect(decodePng(bytesOf(r1.data)).width).toBe(336);
    const three = docFor('business-card', 3, 'Trio');
    const r2 = await exportDocument(three, { format: 'jpg', pageIds: ['pg_2'], env });
    expect(r2.filename).toBe('trio-02.jpg');
    expect(r2.mimeType).toBe('image/jpeg');
    const r3 = await exportDocument(three, { format: 'jpg', pageIds: ['pg_3', 'pg_1'], env });
    expect(readStoredZip(bytesOf(r3.data)).map((e) => e.name)).toEqual(['trio-03.jpg', 'trio-01.jpg']);
  });

  it('round-trips arbitrary entries and rejects corruption', () => {
    const a = new TextEncoder().encode('hello zip');
    const b = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
    const zip = createZip([
      { name: 'a.txt', data: a },
      { name: 'dir/ü.bin', data: b },
    ]);
    const back = readStoredZip(zip);
    expect(back.map((e) => e.name)).toEqual(['a.txt', 'dir/ü.bin']);
    expect(Buffer.from(back[1]!.data).equals(Buffer.from(b))).toBe(true);
    const bad = zip.slice();
    bad[40] = bad[40]! ^ 0xff; // inside a.txt's data
    expect(() => readStoredZip(bad)).toThrow(/CRC/);
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('file names & metadata', () => {
  it('slugify / base names / page numbers', () => {
    expect(slugify('Summer sale — Instagram post')).toBe('summer-sale-instagram-post');
    expect(slugify('Zażółć gęślą jaźń')).toBe('zazolc-gesla-jazn');
    expect(slugify('Straße & Œuvre')).toBe('strasse-uvre');
    expect(slugify('   ')).toBe('');
    expect(exportBaseName('!!!')).toBe('plakat');
    expect(exportBaseName('x'.repeat(200))).toHaveLength(80);
    expect(pageNumberLabel(1, 3)).toBe('01');
    expect(pageNumberLabel(7, 120)).toBe('007');
    expect(pageFileName('menu', 2, 12, 'png')).toBe('menu-02.png');
  });

  it('pHYs and JFIF density writers', () => {
    const png = decodePng(pngBytes());
    expect(png.width).toBe(2);
    const withDpi = setPngDpi(pngBytes(), 300);
    expect(readPngPhys(withDpi)).toEqual({ x: 11811, y: 11811, unit: 1 });
    expect(dpiToPixelsPerMetre(300)).toBe(11811);
    // replacing an existing pHYs keeps a single chunk and a valid PNG
    const twice = setPngDpi(withDpi, 72);
    expect(readPngPhys(twice)).toEqual({ x: 2835, y: 2835, unit: 1 });
    expect(decodePng(twice).width).toBe(2);
    expect(Buffer.from(twice).toString('latin1').split('pHYs').length - 1).toBe(1);
    const notJfif = new Uint8Array([1, 2, 3]);
    expect(setJpegDpi(notJfif, 300)).toBe(notJfif);
  });
});

function pngBytes(): Uint8Array {
  const p = new PNG({ width: 2, height: 2 });
  p.data.fill(255);
  return PNG.sync.write(p);
}

