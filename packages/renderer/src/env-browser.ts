import {
  DEFAULT_CANVAS_LIMITS,
  SAFARI_CANVAS_LIMITS,
  getFontInfo,
  googleFontsCssUrl,
  googleFontVariantCssUrl,
  requestedFontVariants,
  type Asset,
  type CanvasLimits,
  type FontLoadRequest,
  type FontRef,
  type FontVariant,
  type Id,
} from '@plakat/schema';
import { encodeCanvasDefault } from './encode.ts';
import { AssetLoadError, FontLoadError } from './errors.ts';
import { svgRasterScale, svgRasterSize } from './resources.ts';
import type { DecodedImage, ExportData, RenderEnv } from './types.ts';

export interface BrowserEnvOptions {
  /** Overall font barrier timeout (default 15 000 ms, §3.1). */
  fontTimeoutMs?: number;
  /** Stylesheet URL per family (default canonicalFontCssUrl, display=block). */
  fontCssUrl?: (font: Pick<FontRef, 'family' | 'variants'>) => string;
  /** Per-variant fallback URL (default googleFontVariantCssUrl). */
  fontVariantCssUrl?: (family: string, variant: FontVariant) => string;
  /**
   * Map an asset src to the URL actually loaded (e.g. route third-party URLs through
   * `/api/assets/proxy?url=…`, P-4). Default: the src itself.
   */
  resolveSrc?: (src: string, asset: Asset) => string;
  /** Override the WebKit detection used for canvas limits. */
  canvasLimits?: CanvasLimits;
  /** Document to use (default: global `document`, read lazily). */
  document?: Document;
}

/** True on WebKit (Safari, every iOS browser): canvas area is capped at 16.7 MP. */
export function isWebKitBrowser(userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  return /AppleWebKit/.test(userAgent) && !/(Chrome|Chromium|CriOS|Edg|OPR|Android|FxiOS)/.test(userAgent);
}

function variantLabel(family: string, weight: number, style: string): string {
  return `"${family}" ${style} ${weight}`;
}

/** Stylesheet loads per document and href (shared by every env on the page). */
const stylesheetLoads = new WeakMap<Document, Map<string, Promise<boolean>>>();

function loadStylesheet(doc: Document, href: string): Promise<boolean> {
  let perDoc = stylesheetLoads.get(doc);
  if (!perDoc) stylesheetLoads.set(doc, (perDoc = new Map()));
  let p = perDoc.get(href);
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      const link = doc.createElement('link');
      link.addEventListener('load', () => resolve(true), { once: true });
      link.addEventListener('error', () => resolve(false), { once: true });
      link.rel = 'stylesheet';
      link.dataset['plakatFont'] = '';
      link.href = href;
      doc.head.appendChild(link);
    });
    perDoc.set(href, p);
  }
  return p;
}

/**
 * Loads a font stylesheet once per document (shared with every RenderEnv on the page).
 * UI code that previews fonts (font picker) MUST load stylesheets through this with
 * canonicalFontCssUrl(): a second, different stylesheet for a family adds duplicate
 * @font-face rules, and text measured/drawn before vs. after it can differ by sub-pixel
 * amounts, which breaks editor/export parity (§6.2).
 */
export function loadFontStylesheet(href: string, doc: Document = document): Promise<boolean> {
  return loadStylesheet(doc, href);
}

/**
 * THE stylesheet URL for a family: catalogued families always request every variant
 * Google serves for them (display=block), whatever subset a document uses, so each
 * family is added to the page exactly once with one set of @font-face rules, no matter
 * which document, page or export asks first. Font files still load lazily per face
 * (`document.fonts.load`). Uncatalogued families request the variants in `font`.
 */
export function canonicalFontCssUrl(font: Pick<FontRef, 'family' | 'variants'>): string {
  const info = getFontInfo(font.family);
  if (!info) return googleFontsCssUrl(font);
  const variants: FontVariant[] = [
    ...info.normal.map((weight) => ({ weight, style: 'normal' as const })),
    ...info.italic.map((weight) => ({ weight, style: 'italic' as const })),
  ];
  return googleFontsCssUrl({ family: info.family, variants });
}

/**
 * Browser RenderEnv (§3.1, §3.2): Google Fonts stylesheets + `document.fonts.load(query, text)`
 * with per-subset text, images through `HTMLImageElement` (`crossOrigin = 'anonymous'` before
 * `src`, then `decode()`), SVGs rasterized at their declared size × the svgRasterScale the document needs. Nothing
 * here touches the DOM until a method is called.
 */
export function createBrowserEnv(opts: BrowserEnvOptions = {}): RenderEnv {
  const timeoutMs = opts.fontTimeoutMs ?? 15_000;
  const cssUrl = opts.fontCssUrl ?? canonicalFontCssUrl;
  const variantUrl = opts.fontVariantCssUrl ?? ((family, v) => googleFontVariantCssUrl(family, v));
  const getDoc = () => opts.document ?? document;
  const images = new Map<string, Promise<DecodedImage>>();
  /** Stylesheet work per family URL → missing variant labels. */
  const sheets = new Map<string, Promise<string[]>>();

  function ensureFamilyStylesheet(font: FontRef): Promise<string[]> {
    const href = cssUrl(font);
    let p = sheets.get(href);
    if (!p) {
      p = (async () => {
        const doc = getDoc();
        if (await loadStylesheet(doc, href)) return [];
        // css2 answers 400 for the whole family if any variant is missing: retry per variant.
        const missing: string[] = [];
        await Promise.all(
          requestedFontVariants(font).map(async (v) => {
            if (!(await loadStylesheet(doc, variantUrl(font.family, v)))) missing.push(variantLabel(font.family, v.weight, v.style));
          }),
        );
        return missing;
      })();
      sheets.set(href, p);
    }
    return p;
  }

  async function loadImageUncached(src: string, asset: Asset, assetId: Id, svgScale: number): Promise<DecodedImage> {
    const doc = getDoc();
    const img = new Image();
    img.crossOrigin = 'anonymous'; // must be set BEFORE src (P-4)
    img.decoding = 'async';
    img.src = opts.resolveSrc ? opts.resolveSrc(src, asset) : src;
    try {
      await img.decode();
    } catch (err) {
      throw new AssetLoadError(assetId, `Image asset "${assetId}" failed to decode`, { cause: err });
    }
    if (asset.mimeType === 'image/svg+xml') {
      const size = svgRasterSize(asset, svgScale);
      const canvas = doc.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new AssetLoadError(assetId, '2d context unavailable');
      ctx.drawImage(img, 0, 0, size.width, size.height);
      return canvas;
    }
    if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) throw new AssetLoadError(assetId, `Image asset "${assetId}" has no pixels`);
    return img;
  }

  return {
    kind: 'browser',
    loadImage(src, asset, assetId, loadOpts) {
      const svg = asset.mimeType === 'image/svg+xml';
      const svgScale = loadOpts?.svgRasterScale ?? svgRasterScale(asset);
      const size = svg ? svgRasterSize(asset, svgScale) : null;
      const key = size ? `${src}#svg:${asset.width}x${asset.height}@${size.width}x${size.height}` : src;
      let p = images.get(key);
      if (!p) {
        p = loadImageUncached(src, asset, assetId, svgScale);
        images.set(key, p);
        p.catch(() => images.delete(key));
      }
      return p;
    },

    async loadFonts(fonts: FontRef[], requests: FontLoadRequest[]) {
      const doc = getDoc();
      const pending = new Set(requests.map((r) => variantLabel(r.family, r.weight, r.style)));
      const work = (async () => {
        const sheetMissing = (await Promise.all(fonts.map(ensureFamilyStylesheet))).flat();
        const missing = new Set(sheetMissing);
        await Promise.all(
          requests.map(async (req) => {
            const label = variantLabel(req.family, req.weight, req.style);
            let faces: FontFace[] = [];
            try {
              // Pass req.text: only the unicode-range subsets intersecting it are loaded.
              faces = await doc.fonts.load(req.query, req.text);
            } catch {
              faces = [];
            }
            if (faces.length === 0 || !doc.fonts.check(req.query, req.text)) missing.add(label);
            pending.delete(label);
          }),
        );
        if (missing.size > 0) throw new FontLoadError([...missing]);
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FontLoadError([...pending], `Font loading timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await Promise.race([work, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },

    encodeCanvas: encodeCanvasDefault,

    wrapOutput(bytes: Uint8Array, mimeType: string): ExportData {
      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
    },

    canvasLimits() {
      return opts.canvasLimits ?? (isWebKitBrowser() ? SAFARI_CANVAS_LIMITS : DEFAULT_CANVAS_LIMITS);
    },

    createStageContainer() {
      return getDoc().createElement('div');
    },
  };
}
