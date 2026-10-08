/**
 * render-export-pipeline.md §6.1 tests 1 (dimensions, §4.1 table) and 6 (no edge seam, P-8).
 */
import { createTestEnv, decodePng, image, makeDoc, page, pixelAt, rgba, shape, text } from './test-support.ts';
import { describe, expect, it } from 'vitest';
import { PAGE_PRESETS, presetToPageSize, type ExportScaleId, type PresetId } from '@plakat/schema';
import { exportPage, renderPageCanvas } from './export.ts';
import { dpiToPixelsPerMetre, readPngPhys } from './encode.ts';
import { fixtureAssets } from './fixture-docs.ts';
import { CanvasLimitError } from './errors.ts';

const T = { timeout: 180_000 };
const env = createTestEnv();

/** §4.1 — keep in sync with packages/schema/src/units.test.ts. */
const TABLE: Record<PresetId, Record<ExportScaleId, [number, number]>> = {
  'instagram-post': { '1x': [1080, 1080], '2x': [2160, 2160], print: [3375, 3375] },
  'instagram-story': { '1x': [1080, 1920], '2x': [2160, 3840], print: [3375, 6000] },
  'youtube-thumbnail': { '1x': [1280, 720], '2x': [2560, 1440], print: [4000, 2250] },
  'a4-poster': { '1x': [794, 1123], '2x': [1587, 2245], print: [2480, 3508] },
  'business-card': { '1x': [336, 192], '2x': [672, 384], print: [1050, 600] },
  'business-card-eu': { '1x': [321, 208], '2x': [643, 416], print: [1004, 650] },
};

const expected = (id: PresetId, scale: ExportScaleId): [number, number] => TABLE[id]![scale];

const PRINT_PRESETS: PresetId[] = ['a4-poster', 'business-card', 'business-card-eu'];

function presetDoc(id: PresetId) {
  const size = presetToPageSize(id);
  return makeDoc(
    size,
    [
      page('pg_1', [
        shape('el_r', 'rect', { x: 10, y: 10, width: size.width / 2, height: size.height / 3, fill: '#007aff' }),
        text('el_t', { x: 20, y: size.height / 2, width: size.width - 40, height: 40, content: 'Dimensions', fontSize: 24 }),
      ]),
    ],
    {},
    `Preset ${id}`,
  );
}

describe('export dimensions (§6.1.1, §4.1 table)', () => {
  it('covers every preset in the table', () => {
    expect(PAGE_PRESETS.map((p) => p.id).sort()).toEqual(Object.keys(TABLE).sort());
  });

  for (const preset of PAGE_PRESETS) {
    const scales: ExportScaleId[] = PRINT_PRESETS.includes(preset.id) ? ['1x', '2x', 'print'] : ['1x', '2x'];
    for (const scale of scales) {
      it(`${preset.id} @ ${scale} → ${expected(preset.id, scale).join(' × ')}`, T, async () => {
        const doc = presetDoc(preset.id);
        const bytes = (await exportPage(doc, 'pg_1', { format: 'png', scale, env })) as Uint8Array;
        const png = decodePng(bytes);
        expect([png.width, png.height]).toEqual(expected(preset.id, scale));
        const phys = readPngPhys(bytes);
        if (scale === 'print') expect(phys).toEqual({ x: dpiToPixelsPerMetre(300), y: dpiToPixelsPerMetre(300), unit: 1 });
        else expect(phys).toBeNull();
      });
    }
  }

  it('JPG has the same dimensions as PNG', T, async () => {
    const { loadImage } = await import('canvas');
    const doc = presetDoc('business-card-eu');
    const bytes = (await exportPage(doc, 'pg_1', { format: 'jpg', scale: '2x', env })) as Uint8Array;
    const img = await loadImage(Buffer.from(bytes));
    expect([img.width, img.height]).toEqual(expected('business-card-eu', '2x'));
  });

  it('refuses a bitmap over the canvas limits with a clear error', async () => {
    const doc = presetDoc('instagram-story');
    await expect(
      exportPage(doc, 'pg_1', { format: 'png', scale: 'print', env, canvasLimits: { maxSide: 16_384, maxArea: 16_777_216 } }),
    ).rejects.toBeInstanceOf(CanvasLimitError);
  });
});

describe('no edge seam (§6.1.6, P-8)', () => {
  const cases: [PresetId, ExportScaleId][] = [
    ['a4-poster', '1x'],
    ['a4-poster', 'print'],
    ['business-card-eu', '2x'],
  ];
  for (const [preset, scale] of cases) {
    it(`full-bleed #000000 rect on ${preset} @ ${scale} is black in every edge pixel`, T, async () => {
      const size = presetToPageSize(preset);
      const doc = makeDoc(size, [
        page('pg_1', [shape('el_bleed', 'rect', { x: 0, y: 0, width: size.width, height: size.height, fill: '#000000' })], {
          color: '#ffffff',
          image: null,
        }),
      ]);
      const r = await renderPageCanvas(doc, 'pg_1', { scale, env });
      const px = rgba(r.canvas);
      const { width: W, height: H } = r;
      r.release();
      const bad: string[] = [];
      for (let y = 0; y < H; y++) {
        for (const x of [0, W - 1]) if (pixelAt(px, W, x, y).join() !== '0,0,0,255') bad.push(`${x},${y}`);
      }
      for (let x = 0; x < W; x++) {
        for (const y of [0, H - 1]) if (pixelAt(px, W, x, y).join() !== '0,0,0,255') bad.push(`${x},${y}`);
      }
      expect(bad.slice(0, 10)).toEqual([]);
    });

    it(`full-bleed dark image on ${preset} @ ${scale} leaves no light seam`, T, async () => {
      const size = presetToPageSize(preset);
      const doc = makeDoc(
        size,
        [page('pg_1', [image('el_bleed', 'as_dark', { x: 0, y: 0, width: size.width, height: size.height })], { color: '#ffffff', image: null })],
        { as_dark: fixtureAssets()['as_dark']! },
      );
      const r = await renderPageCanvas(doc, 'pg_1', { scale, env });
      const px = rgba(r.canvas);
      const { width: W, height: H } = r;
      r.release();
      let worst = 0;
      for (let y = 0; y < H; y++) for (const x of [0, W - 1]) worst = Math.max(worst, ...pixelAt(px, W, x, y).slice(0, 3));
      for (let x = 0; x < W; x++) for (const y of [0, H - 1]) worst = Math.max(worst, ...pixelAt(px, W, x, y).slice(0, 3));
      // the dark fixture's edge colour is #050505; a seam would blend in the white page (≥ 0x40)
      expect(worst).toBeLessThanOrEqual(0x10);
    });
  }
});
