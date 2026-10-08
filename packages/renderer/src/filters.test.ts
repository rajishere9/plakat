/**
 * render-export-pipeline.md §6.1 tests 4 (filter cache ratio) and 5 (filter cache
 * truncation), plus the §3.5 filter mapping.
 */
import { createTestEnv, countDiffBytes, image, makeDoc, page, rgba } from './test-support.ts';
import { describe, expect, it } from 'vitest';
import pixelmatch from 'pixelmatch';
import { DEFAULT_FILTERS, customPageSize, exportPixelSize, type PlakatDocument } from '@plakat/schema';
import { fixtureAssets } from './fixture-docs.ts';
import { cacheFilteredNode, filterCacheOffset, hasActiveFilters, konvaFilterList, konvaSaturation, planFilterCache } from './filters.ts';
import { CanvasLimitError } from './errors.ts';
import type { CanvasLimits } from '@plakat/schema';
import { Konva, type KonvaGroup, type KonvaImage } from './konva.ts';
import { prepareResources } from './resources.ts';
import { rasterizePage } from './rasterize.ts';
import { renderPageCanvas } from './export.ts';
import { PageScene } from './scene.ts';

const T = { timeout: 120_000 };
const env = createTestEnv();

function imageNode(scene: PageScene, id: string): KonvaImage {
  const flip = scene.getElementNode(id)!.getChildren()[1] as KonvaGroup;
  const node = flip.getChildren()[0];
  if (!(node instanceof Konva.Image)) throw new Error('not an image node');
  return node;
}

function singleImageDoc(p: Parameters<typeof image>[2], bg: string | null = '#ffffff'): PlakatDocument {
  return makeDoc(customPageSize(1080, 1080), [page('pg_1', [image('el_img', 'as_photo', p)], { color: bg, image: null })], {
    as_photo: fixtureAssets()['as_photo']!,
  });
}

describe('filter mapping (§3.5)', () => {
  it('uses function filters in the fixed order, non-neutral only', () => {
    const F = Konva.Filters;
    expect(konvaFilterList(DEFAULT_FILTERS)).toEqual([]);
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    const all = { brightness: 10, contrast: -20, saturation: 30, blur: 2, grayscale: true, sepia: true, invert: true };
    expect(konvaFilterList(all)).toEqual([F.Brighten, F.Contrast, F.HSL, F.Grayscale, F.Sepia, F.Invert, F.Blur]);
    expect(konvaFilterList(all).every((f) => typeof f === 'function')).toBe(true);
  });

  it('maps saturation through log2 (−100 → ≈0 chroma, +100 → 2×)', () => {
    expect(konvaSaturation(0)).toBe(0);
    expect(konvaSaturation(100)).toBe(1);
    expect(konvaSaturation(-100)).toBe(-10);
    expect(konvaSaturation(-50)).toBeCloseTo(-1, 12);
  });

  it('P-7 cache offset is at least one logical and one device px', () => {
    expect(filterCacheOffset(1)).toBe(1);
    expect(filterCacheOffset(3.125)).toBe(1);
    expect(filterCacheOffset(0.37)).toBe(3);
    expect(filterCacheOffset(0.5) * 0.5).toBeGreaterThanOrEqual(1);
  });

  it('caches filtered images at the scene ratio and never caches unfiltered ones', async () => {
    const doc = makeDoc(
      customPageSize(400, 400),
      [
        page('pg_1', [
          image('el_plain', 'as_photo', { x: 10, y: 10 }),
          image('el_f', 'as_photo', { x: 10, y: 200, filters: { blur: 4 } }),
        ]),
      ],
      { as_photo: fixtureAssets()['as_photo']! },
    );
    const resources = await prepareResources(doc, undefined, env);
    const scene = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: 1.5 });
    expect(imageNode(scene, 'el_plain').isCached()).toBe(false);
    const f = imageNode(scene, 'el_f');
    expect(f.isCached()).toBe(true);
    const cache = (f as unknown as { _getCanvasCache(): { scene: { pixelRatio: number } } })._getCanvasCache();
    expect(cache.scene.pixelRatio).toBe(1.5);
    scene.setPixelRatio(2.5);
    const cache2 = (f as unknown as { _getCanvasCache(): { scene: { pixelRatio: number } } })._getCanvasCache();
    expect(cache2.scene.pixelRatio).toBe(2.5);
    scene.destroy();
  });
});

describe('filter cache ratio (§6.1.4)', () => {
  it('a blur cached at the output ratio equals the export; a ratio-1 cache differs', T, async () => {
    const doc = singleImageDoc({ x: 100, y: 120, width: 400, height: 300, filters: { blur: 8 } });
    const s = 2;
    const { width: W, height: H } = exportPixelSize(doc.size, s);
    const resources = await prepareResources(doc, undefined, env);
    const exported = await renderPageCanvas(doc, 'pg_1', { scale: s, env });
    const ref = rgba(exported.canvas);
    exported.release();

    // an editor scene at another on-screen ratio is re-cached for the raster
    const editor = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: 0.5 });
    expect(rgba(rasterizePage(editor, s)).equals(ref)).toBe(true);
    editor.destroy();

    const scene = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: s });
    const good = rgba(rasterizePage(scene, s));
    expect(good.equals(ref)).toBe(true);

    const node = imageNode(scene, 'el_img');
    node.clearCache();
    node.cache({ pixelRatio: 1 }); // deliberately wrong: the regression this test guards against
    const bad = rgba(rasterizePage(scene, s)); // setPixelRatio(s) is a no-op: the bad cache stays
    expect(bad.equals(ref)).toBe(false);
    expect(pixelmatch(bad, ref, null, W, H, { threshold: 0 })).toBeGreaterThan(1000);
    scene.destroy();
  });
});

describe('filter cache truncation (§6.1.5)', () => {
  // 100 × 3.125 = 312.5 device px: Konva's floor() would cut the last half column/row
  // without the P-7 offset padding. x = y = 33 puts the padded cache origin
  // ((33 − 1) × 3.125 = 100) on a whole device pixel, so a correct cache is a 1:1 copy.
  const p = { x: 33, y: 33, width: 100, height: 100 };

  const cases = [
    { bg: '#ffffff', cornerRadius: 0 },
    { bg: null, cornerRadius: 0 },
    { bg: '#ffffff', cornerRadius: 6 },
    { bg: null, cornerRadius: 6 },
  ] as const;
  for (const { bg, cornerRadius } of cases) {
    it(`at print, a neutral-filter image forced through the P-7 cache equals it uncached (background ${bg ?? 'transparent'}, cornerRadius ${cornerRadius})`, T, async () => {
      const doc = singleImageDoc({ ...p, cornerRadius }, bg);
      const resources = await prepareResources(doc, undefined, env);
      const s = 3.125;
      const { width: W, height: H } = exportPixelSize(doc.size, s);
      const plain = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: s });
      const uncached = rgba(rasterizePage(plain, 'print'));
      plain.destroy();

      const scene = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: s });
      const node = imageNode(scene, 'el_img');
      expect(node.isCached()).toBe(false);
      cacheFilteredNode(node, s);
      expect(node.isCached()).toBe(true);
      const cached = rgba(rasterizePage(scene, 'print'));
      expect(countDiffBytes(cached, uncached)).toBe(0);
      expect(pixelmatch(cached, uncached, null, W, H, { threshold: 0 })).toBe(0);

      // Without the offset padding the bitmap is truncated (teeth). node-canvas snaps the
      // far edge of a scaled drawImage to whole pixels, so the cut half column is only
      // observable on a vector (antialiased) edge: the rounded-corner clip path.
      node.clearCache();
      node.cache({ pixelRatio: s });
      const truncated = rgba(rasterizePage(scene, 'print'));
      if (cornerRadius > 0) expect(truncated.equals(uncached)).toBe(false);
      scene.destroy();
    });
  }
});

describe('filter cache size limits (P-7): never a silently missing filtered image', () => {
  /** Device size of a node's filter cache bitmap. */
  function cacheBitmap(node: KonvaImage): { width: number; height: number } {
    const cache = (node as unknown as { _getCanvasCache(): { scene: { _canvas: { width: number; height: number } } } })._getCanvasCache();
    return { width: cache.scene._canvas.width, height: cache.scene._canvas.height };
  }

  function bigImageDoc(pageSide: number, p: Parameters<typeof image>[2]): PlakatDocument {
    return makeDoc(customPageSize(pageSide, pageSide), [page('pg_1', [image('el_img', 'as_photo', { filters: { grayscale: true }, ...p })], { color: '#ffffff', image: null })], {
      as_photo: fixtureAssets()['as_photo']!,
    });
  }

  const centerPixel = (buf: Uint8Array, w: number, h: number) => {
    const i = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
    return [buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!];
  };

  it('a node much larger than the page is cached only where the page can show it', async () => {
    const limits: CanvasLimits = { maxSide: 32_767, maxArea: 250_000 };
    const doc = bigImageDoc(100, { x: -200, y: -500, width: 1000, height: 1000 });
    const resources = await prepareResources(doc, undefined, env);
    const scene = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: 1, canvasLimits: limits });
    const bmp = cacheBitmap(imageNode(scene, 'el_img'));
    expect(bmp.width * bmp.height).toBeLessThanOrEqual(limits.maxArea);
    expect(bmp.width).toBeLessThan(200); // the page (100 px) + blur/offset padding, not 1000
    scene.destroy();
  });

  for (const scale of [1, 2, 3.125]) {
    // Integer ratios: byte-identical. Fractional ratios: the page's contentScale moves the
    // cropped cache by a sub-pixel amount, so channels may differ by 1 level (rounding).
    it(`cropping the cache to the page does not visibly change pixels (@ ${scale})`, T, async () => {
      const doc = bigImageDoc(100, { x: -203.3, y: -497.1, width: 1000, height: 1000, filters: { grayscale: true, blur: 3 } });
      const full = await renderPageCanvas(doc, 'pg_1', { scale, env });
      const limits: CanvasLimits = { maxSide: 32_767, maxArea: Math.ceil(400 * scale) ** 2 };
      const cropped = await renderPageCanvas(doc, 'pg_1', { scale, env, canvasLimits: limits });
      const resources = await prepareResources(doc, undefined, env);
      const probe = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: scale, canvasLimits: limits });
      expect(planFilterCache(imageNode(probe, 'el_img'), scale, { limits, visible: { x: 0, y: 0, width: 1, height: 1 } })!.cropped).toBe(true);
      probe.destroy();
      const a = rgba(full.canvas);
      const b = rgba(cropped.canvas);
      let maxDiff = 0;
      for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
      if (Number.isInteger(scale)) expect(countDiffBytes(a, b)).toBe(0);
      else expect(maxDiff).toBeLessThanOrEqual(1);
      full.release();
      cropped.release();
    });
  }

  it('editor: at extreme zoom the cache ratio is clamped to the budget and the image stays visible', async () => {
    const limits: CanvasLimits = { maxSide: 32_767, maxArea: 250_000 };
    const doc = bigImageDoc(100, { x: 0, y: 0, width: 100, height: 100 });
    const resources = await prepareResources(doc, undefined, env);
    const scene = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: 1, canvasLimits: limits });
    scene.setPixelRatio(16); // zoom 8 × dpr 2: the whole cache would be 1632² px
    const node = imageNode(scene, 'el_img');
    const bmp = cacheBitmap(node);
    expect(bmp.width * bmp.height).toBeLessThanOrEqual(limits.maxArea);
    expect(bmp.width).toBeGreaterThan(400); // still well above 1x
    const raster = rasterizePage(scene, 1);
    const [r, g, b, a] = centerPixel(rgba(raster), raster.width, raster.height);
    Konva.Util.releaseCanvas(raster);
    expect(a).toBe(255);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBeLessThan(250); // the grayscale photo, not the white page
    scene.destroy();
  });

  it('export refuses (CanvasLimitError) instead of writing a file without the filtered image', T, async () => {
    // page 400² fits the limits; the filtered image's cache, even cropped to the page, does not
    const limits: CanvasLimits = { maxSide: 32_767, maxArea: 170_000 };
    const doc = bigImageDoc(400, { x: -300, y: -300, width: 1000, height: 1000, filters: { grayscale: true, blur: 20 } });
    await expect(renderPageCanvas(doc, 'pg_1', { scale: 1, env, canvasLimits: limits })).rejects.toBeInstanceOf(CanvasLimitError);
    await expect(renderPageCanvas(doc, 'pg_1', { scale: 1, env, canvasLimits: limits })).rejects.toThrow(/filter cache/);
    // the same image cropped to the page fits more generous limits, and renders
    const ok = await renderPageCanvas(doc, 'pg_1', { scale: 1, env, canvasLimits: { maxSide: 32_767, maxArea: 250_000 } });
    const [r, g, b, a] = centerPixel(rgba(ok.canvas), ok.width, ok.height);
    ok.release();
    expect([a, r === g && g === b]).toEqual([255, true]);
  });
});
