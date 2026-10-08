import { resolveFontVariant } from './font-catalog.ts';
import type { FontRef, FontStyle, FontVariant, FontWeight, Id, PlakatDocument, TextTransform } from './types.ts';

export const DEFAULT_FONT_FAMILY = 'Inter';
export const GOOGLE_FONTS_CSS_ENDPOINT = 'https://fonts.googleapis.com/css2';

function compareVariants(a: FontVariant, b: FontVariant): number {
  if (a.style !== b.style) return a.style === 'normal' ? -1 : 1;
  return a.weight - b.weight;
}

/**
 * Computes the exact font variants used by text elements (hidden elements included,
 * since unhiding must not need a network round-trip). Families keep first-seen order;
 * `source` is taken from `doc.fonts` when listed there, else "google".
 */
export function collectFonts(doc: Pick<PlakatDocument, 'pages' | 'fonts'>): FontRef[] {
  const byFamily = new Map<string, Map<string, FontVariant>>();
  for (const page of doc.pages) {
    for (const el of page.elements) {
      if (el.type !== 'text') continue;
      let variants = byFamily.get(el.fontFamily);
      if (!variants) byFamily.set(el.fontFamily, (variants = new Map()));
      variants.set(`${el.fontStyle}:${el.fontWeight}`, { weight: el.fontWeight, style: el.fontStyle });
    }
  }
  const sourceOf = new Map(doc.fonts.map((f) => [f.family, f.source] as const));
  return [...byFamily].map(([family, variants]) => ({
    family,
    source: sourceOf.get(family) ?? 'google',
    variants: [...variants.values()].sort(compareVariants),
  }));
}

/** Returns a copy of the document whose `fonts` cache matches its text elements. */
export function syncFonts<D extends Pick<PlakatDocument, 'pages' | 'fonts'>>(doc: D): D {
  return { ...doc, fonts: collectFonts(doc) };
}

function cssUrl(family: string, variants: readonly FontVariant[], display: string): string {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  const hasItalic = variants.some((v) => v.style === 'italic');
  const axes = hasItalic
    ? `ital,wght@${variants.map((v) => `${v.style === 'italic' ? 1 : 0},${v.weight}`).join(';')}`
    : `wght@${variants.map((v) => v.weight).join(';')}`;
  return `${GOOGLE_FONTS_CSS_ENDPOINT}?family=${fam}:${axes}&display=${display}`;
}

/**
 * The variants to REQUEST from Google Fonts for a FontRef: each used variant mapped
 * through resolveFontVariant() (catalogued families only ask for faces that exist;
 * the browser synthesizes the rest identically in editor and export), deduplicated
 * and sorted.
 */
export function requestedFontVariants(font: Pick<FontRef, 'family' | 'variants'>): FontVariant[] {
  const out = new Map<string, FontVariant>();
  for (const v of font.variants) {
    const r = resolveFontVariant(font.family, v.weight, v.style);
    out.set(`${r.style}:${r.weight}`, r);
  }
  return [...out.values()].sort(compareVariants);
}

/**
 * Google Fonts CSS2 URL for ONE family (one URL per family so a bad family cannot
 * fail other families). Requests requestedFontVariants(). `display=block` avoids a
 * fallback flash being captured mid-load. css2 answers HTTP 400 if ANY requested
 * variant is missing (possible only for uncatalogued families): loaders then retry
 * with googleFontVariantCssUrl() per variant and report only the failures.
 */
export function googleFontsCssUrl(font: Pick<FontRef, 'family' | 'variants'>, display = 'block'): string {
  return cssUrl(font.family, requestedFontVariants(font), display);
}

/** css2 URL for exactly one variant (the per-variant fallback of googleFontsCssUrl). */
export function googleFontVariantCssUrl(family: string, variant: FontVariant, display = 'block'): string {
  return cssUrl(family, [variant], display);
}

/** CSS font shorthand for `document.fonts.load()` / `check()`, e.g. `italic 700 16px "Playfair Display"`. */
export function fontLoadQuery(family: string, weight: number, style: FontStyle, sizePx = 16): string {
  return `${style} ${weight} ${sizePx}px "${family.replace(/["\\]/g, '\\$&')}"`;
}

/** One `document.fonts.load(query, text)` / `check(query, text)` call of the readiness barrier. */
export interface FontLoadRequest {
  family: string;
  weight: FontWeight;
  style: FontStyle;
  /** CSS font shorthand (fontLoadQuery). */
  query: string;
  /**
   * Every character rendered with this face (after textTransform), plus a space.
   * Google Fonts splits families into unicode-range subsets (latin, latin-ext,
   * cyrillic, greek, vietnamese, ...) and the browser only loads subsets that
   * intersect this text; the default text (" ") would load latin only.
   */
  text: string;
}

export interface FontLoadRequestOptions {
  /** Restrict to these pages (default: all pages). Hidden elements are always included. */
  pageIds?: readonly Id[];
}

/**
 * The font readiness barrier's work list: one request per (family, weight, style)
 * used by text elements on the selected pages, with the exact characters to load.
 * Deterministic order: families first-seen, variants normal<italic then weight asc;
 * `text` is the sorted set of code points (control characters removed).
 */
export function fontLoadRequests(
  doc: Pick<PlakatDocument, 'pages'>,
  options: FontLoadRequestOptions = {},
): FontLoadRequest[] {
  const pageFilter = options.pageIds ? new Set(options.pageIds) : null;
  const byFamily = new Map<string, Map<string, { variant: FontVariant; chars: Set<string> }>>();
  for (const page of doc.pages) {
    if (pageFilter && !pageFilter.has(page.id)) continue;
    for (const el of page.elements) {
      if (el.type !== 'text') continue;
      let variants = byFamily.get(el.fontFamily);
      if (!variants) byFamily.set(el.fontFamily, (variants = new Map()));
      const key = `${el.fontStyle}:${el.fontWeight}`;
      let entry = variants.get(key);
      if (!entry) variants.set(key, (entry = { variant: { weight: el.fontWeight, style: el.fontStyle }, chars: new Set([' ']) }));
      for (const ch of applyTextTransform(el.content, el.textTransform)) {
        if (!/\p{Cc}/u.test(ch)) entry.chars.add(ch);
      }
    }
  }
  const out: FontLoadRequest[] = [];
  for (const [family, variants] of byFamily) {
    for (const { variant, chars } of [...variants.values()].sort((a, b) => compareVariants(a.variant, b.variant))) {
      out.push({
        family,
        weight: variant.weight,
        style: variant.style,
        query: fontLoadQuery(family, variant.weight, variant.style),
        text: [...chars].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!).join(''),
      });
    }
  }
  return out;
}

/**
 * Applies a TextTransform the same way in editor and export (Konva has no
 * text-transform). `capitalize` uppercases the first letter of each
 * whitespace-separated word, like CSS.
 */
export function applyTextTransform(content: string, transform: TextTransform): string {
  switch (transform) {
    case 'none':
      return content;
    case 'uppercase':
      return content.toUpperCase();
    case 'lowercase':
      return content.toLowerCase();
    case 'capitalize':
      return content.replace(/(^|\s)(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
  }
}
