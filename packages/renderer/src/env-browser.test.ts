/**
 * createBrowserEnv against minimal DOM fakes (the real thing runs in Playwright, §6.2):
 * import safety, the font barrier protocol (§3.1) and image loading order (§3.2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fontLoadRequests, collectFonts, googleFontsCssUrl, type Asset } from '@plakat/schema';
import { canonicalFontCssUrl, createBrowserEnv, isWebKitBrowser } from './env-browser.ts';
import { FontLoadError } from './errors.ts';
import { imageAsset, makeDoc, page, pngDataUri, drawPhoto, text, SVG_SRC } from './test-support.ts';

interface FakeLink {
  rel: string;
  href: string;
  dataset: Record<string, string>;
  listeners: Record<string, (() => void)[]>;
  addEventListener(type: string, fn: () => void): void;
}

function fakeDocument(opts: { failHref?: (href: string) => boolean; loadedFamilies: Set<string>; checkOk?: boolean }) {
  const links: FakeLink[] = [];
  const canvases: { width: number; height: number; draws: unknown[][] }[] = [];
  const loads: { query: string; text: string }[] = [];
  const doc = {
    head: {
      appendChild(link: FakeLink) {
        links.push(link);
        setTimeout(() => (link.listeners[opts.failHref?.(link.href) ? 'error' : 'load'] ?? []).forEach((f) => f()), 0);
      },
    },
    createElement(tag: string) {
      if (tag === 'canvas') {
        const c = { width: 0, height: 0, draws: [] as unknown[][], getContext: () => ({ drawImage: (...a: unknown[]) => c.draws.push(a) }) };
        canvases.push(c);
        return c;
      }
      const link: FakeLink = {
        rel: '',
        href: '',
        dataset: {},
        listeners: {},
        addEventListener(type, fn) {
          (this.listeners[type] ??= []).push(fn);
        },
      };
      return link;
    },
    fonts: {
      async load(query: string, txt: string) {
        loads.push({ query, text: txt });
        const fam = /"([^"]+)"/.exec(query)![1]!;
        return opts.loadedFamilies.has(fam) ? [{ family: fam }] : [];
      },
      check: () => opts.checkOk ?? true,
    },
  };
  return { doc: doc as unknown as Document, links, loads, canvases };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createBrowserEnv', () => {
  it('constructs without touching the DOM (safe to import/create under Node)', () => {
    const env = createBrowserEnv();
    expect(env.kind).toBe('browser');
  });

  it('injects one stylesheet per family, loads every face with its text, then checks', async () => {
    const doc = makeDoc('instagram-post', [
      page('pg_1', [
        text('el_a', { content: 'Zażółć', fontFamily: 'Inter', fontWeight: 400 }),
        text('el_b', { content: 'Привет', fontFamily: 'Inter', fontWeight: 700 }),
        text('el_c', { content: 'x', fontFamily: 'Lobster', fontWeight: 400 }),
      ]),
    ]);
    const fake = fakeDocument({ loadedFamilies: new Set(['Inter', 'Lobster']) });
    const env = createBrowserEnv({ document: fake.doc });
    const fonts = collectFonts(doc);
    const reqs = fontLoadRequests(doc);
    await env.loadFonts(fonts, reqs);
    expect(fake.links.map((l) => l.href)).toEqual(fonts.map((f) => canonicalFontCssUrl(f)));
    // catalogued family: every variant Google serves, whatever the document uses
    expect(fake.links[0]!.href).toContain('ital,wght@0,100;');
    expect(fake.links[0]!.href).toContain(';1,900&');
    // uncatalogued family: only the variants in use
    expect(fake.links[1]!.href).toBe(googleFontsCssUrl(fonts[1]!));
    expect(fake.links.every((l) => l.rel === 'stylesheet' && l.href.includes('display=block'))).toBe(true);
    expect(fake.loads).toEqual(reqs.map((r) => ({ query: r.query, text: r.text })));
    expect(fake.loads[0]!.text).toContain('ż');
    expect(fake.loads[1]!.text).toContain('П');
    // second call reuses the stylesheets
    await env.loadFonts(fonts, reqs);
    expect(fake.links).toHaveLength(2);
  });

  it('retries per variant after a failed family stylesheet and reports missing faces', async () => {
    const doc = makeDoc('instagram-post', [
      page('pg_1', [
        text('el_a', { content: 'a', fontFamily: 'Uncatalogued Fam', fontWeight: 400 }),
        text('el_b', { content: 'b', fontFamily: 'Uncatalogued Fam', fontWeight: 900 }),
      ]),
    ]);
    const fake = fakeDocument({
      loadedFamilies: new Set(['Uncatalogued Fam']),
      failHref: (href) => href.includes('400;900') || href.includes('wght@900'),
      checkOk: true,
    });
    const env = createBrowserEnv({ document: fake.doc });
    const err = await env.loadFonts(collectFonts(doc), fontLoadRequests(doc)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FontLoadError);
    expect((err as FontLoadError).missing).toEqual(['"Uncatalogued Fam" normal 900']);
    expect(fake.links.map((l) => l.href.replace(/^.*family=/, ''))).toEqual([
      'Uncatalogued+Fam:wght@400;900&display=block',
      'Uncatalogued+Fam:wght@400&display=block',
      'Uncatalogued+Fam:wght@900&display=block',
    ]);
  });

  it('times out with FontLoadError', async () => {
    const doc = makeDoc('instagram-post', [page('pg_1', [text('el_a', { content: 'a', fontFamily: 'Inter' })])]);
    const fake = fakeDocument({ loadedFamilies: new Set(['Inter']) });
    (fake.doc.fonts as unknown as { load: () => Promise<unknown> }).load = () => new Promise(() => {});
    const env = createBrowserEnv({ document: fake.doc, fontTimeoutMs: 20 });
    await expect(env.loadFonts(collectFonts(doc), fontLoadRequests(doc))).rejects.toThrow(/timed out/);
  });

  it('sets crossOrigin before src, awaits decode(), caches by src and rasterizes SVG at declared size', async () => {
    const order: string[] = [];
    let created = 0;
    class FakeImage {
      naturalWidth = 0;
      naturalHeight = 0;
      width = 0;
      height = 0;
      decoding = '';
      private _src = '';
      private _co: string | null = null;
      constructor() {
        created++;
      }
      set crossOrigin(v: string) {
        order.push('crossOrigin');
        this._co = v;
      }
      get crossOrigin(): string | null {
        return this._co;
      }
      set src(v: string) {
        order.push('src');
        this._src = v;
      }
      get src() {
        return this._src;
      }
      async decode() {
        order.push('decode');
        this.naturalWidth = this.width = 200;
        this.naturalHeight = this.height = 150;
      }
    }
    vi.stubGlobal('Image', FakeImage);
    const fake = fakeDocument({ loadedFamilies: new Set() });
    const env = createBrowserEnv({ document: fake.doc, resolveSrc: (s) => `proxied:${s.slice(0, 10)}` });
    const asset: Asset = imageAsset(pngDataUri(200, 150, drawPhoto), 200, 150);
    const a = await env.loadImage(asset.src, asset, 'as_1');
    const b = await env.loadImage(asset.src, asset, 'as_1');
    expect(a).toBe(b);
    expect(created).toBe(1);
    expect(order).toEqual(['crossOrigin', 'src', 'decode']);
    expect((a as unknown as FakeImage).crossOrigin).toBe('anonymous');
    expect((a as unknown as FakeImage).src).toBe(`proxied:${asset.src.slice(0, 10)}`);
    const svg = imageAsset(SVG_SRC, 120, 80, 'image/svg+xml');
    const s = await env.loadImage(svg.src, svg, 'as_svg');
    expect([s.width, s.height]).toEqual([480, 320]);
    expect(fake.canvases[0]!.draws[0]!.slice(1)).toEqual([0, 0, 480, 320]);
    // the scale prepareResources asks for (how large the document draws the SVG)
    const big = await env.loadImage(svg.src, svg, 'as_svg', { svgRasterScale: 8 });
    expect([big.width, big.height]).toEqual([960, 640]);
    expect(big).not.toBe(s);
    expect(await env.loadImage(svg.src, svg, 'as_svg', { svgRasterScale: 8 })).toBe(big);
  });

  it('detects WebKit for the Safari canvas limit', () => {
    expect(isWebKitBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe(true);
    expect(isWebKitBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe(false);
    expect(isWebKitBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1')).toBe(true);
    expect(isWebKitBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe(false);
    expect(createBrowserEnv({ canvasLimits: { maxSide: 1, maxArea: 1 } }).canvasLimits!()).toEqual({ maxSide: 1, maxArea: 1 });
  });
});

describe('package entry', () => {
  it('index imports without a DOM and exposes the public API', async () => {
    const mod = await import('./index.ts');
    for (const name of [
      'PageScene',
      'rasterizePage',
      'prepareResources',
      'exportPage',
      'exportDocument',
      'renderPageCanvas',
      'createBrowserEnv',
      'mountPageScene',
      'getElementIdFromNode',
      'applyElement',
      'createZip',
      'slugify',
    ]) {
      expect(mod).toHaveProperty(name);
    }
  });
});
