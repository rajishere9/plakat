/**
 * Font picker data and Bold/Italic helpers on top of GOOGLE_FONTS_CATALOG. Catalogued
 * families only offer variants Google Fonts actually serves (schema §9).
 */
import {
  DEFAULT_FONT_FAMILY,
  getFontInfo,
  GOOGLE_FONTS_CATALOG,
  hasFontVariant,
  matchFontWeight,
  type FontCategory,
  type FontStyle,
  type FontWeight,
  type GoogleFontInfo,
} from '@plakat/schema';
import { canonicalFontCssUrl, loadFontStylesheet } from '@plakat/renderer';

export { DEFAULT_FONT_FAMILY };

export const ALL_FONT_WEIGHTS: readonly FontWeight[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];

export const FONT_WEIGHT_NAMES: Readonly<Record<FontWeight, string>> = {
  100: 'Thin',
  200: 'Extra light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extra bold',
  900: 'Black',
};

export const FONT_CATEGORY_LABELS: Readonly<Record<FontCategory, string>> = {
  'sans-serif': 'Sans serif',
  serif: 'Serif',
  display: 'Display',
  handwriting: 'Handwriting',
  monospace: 'Monospace',
};

/** Picker entries, alphabetical within catalog categories. */
export function getFontPickerGroups(): { category: FontCategory; label: string; fonts: GoogleFontInfo[] }[] {
  const order: FontCategory[] = ['sans-serif', 'serif', 'display', 'handwriting', 'monospace'];
  return order
    .map((category) => ({
      category,
      label: FONT_CATEGORY_LABELS[category],
      fonts: GOOGLE_FONTS_CATALOG.filter((f) => f.category === category).sort((a, b) => a.family.localeCompare(b.family)),
    }))
    .filter((g) => g.fonts.length > 0);
}

/** Case-insensitive substring search over the catalog (empty query = whole catalog, alphabetical). */
export function searchFonts(query: string): GoogleFontInfo[] {
  const q = query.trim().toLowerCase();
  return GOOGLE_FONTS_CATALOG.filter((f) => !q || f.family.toLowerCase().includes(q)).sort((a, b) => a.family.localeCompare(b.family));
}

/** Weights to offer for a family/style (uncatalogued: all nine). */
export function availableWeights(family: string, style: FontStyle = 'normal'): readonly FontWeight[] {
  const info = getFontInfo(family);
  if (!info) return ALL_FONT_WEIGHTS;
  const list = style === 'italic' ? info.italic : info.normal;
  return list.length ? list : info.normal;
}

export function hasItalic(family: string): boolean {
  const info = getFontInfo(family);
  return !info || info.italic.length > 0;
}

/**
 * The (weight, style) to use when switching to `family`, keeping the current look as
 * close as possible: the nearest available weight, italic dropped if the family has none.
 */
export function adaptVariantToFamily(family: string, weight: FontWeight, style: FontStyle): { fontWeight: FontWeight; fontStyle: FontStyle } {
  const info = getFontInfo(family);
  if (!info) return { fontWeight: weight, fontStyle: style };
  const fontStyle: FontStyle = style === 'italic' && info.italic.length > 0 ? 'italic' : 'normal';
  const list = fontStyle === 'italic' ? info.italic : info.normal;
  return { fontWeight: matchFontWeight(weight, list), fontStyle };
}

/** Bold is "on" at weight >= 600. */
export function isBold(weight: number): boolean {
  return weight >= 600;
}

/** Bold toggle target weight: off -> 400 (nearest available), on -> 700 (nearest available >= 600 if any). */
export function toggledBoldWeight(family: string, weight: FontWeight, style: FontStyle): FontWeight {
  const list = availableWeights(family, style);
  if (isBold(weight)) return matchFontWeight(400, list);
  const heavy = list.filter((w) => w >= 600);
  return heavy.length ? matchFontWeight(700, heavy) : matchFontWeight(700, list);
}

/** Whether Bold can be toggled for a family (some weight >= 600 and some < 600 exist). */
export function canToggleBold(family: string, style: FontStyle = 'normal'): boolean {
  const list = availableWeights(family, style);
  return list.some((w) => w >= 600) && list.some((w) => w < 600);
}

/** Whether Italic can be enabled for the family at this weight. */
export function canItalic(family: string, weight: FontWeight): boolean {
  return hasItalic(family) && (hasFontVariant(family, weight, 'italic') || availableWeights(family, 'italic').length > 0);
}

/**
 * Stylesheet URL to preview a family in the picker. This is the SAME canonical URL the
 * canvas and exports use (canonicalFontCssUrl): a separate preview stylesheet would add
 * duplicate @font-face rules for the family, and text laid out before vs. after them
 * renders sub-pixel differently, breaking editor/export parity.
 */
export function fontPreviewCssUrl(family: string): string {
  const info = getFontInfo(family);
  const weight = info ? matchFontWeight(400, info.normal) : 400;
  return canonicalFontCssUrl({ family, variants: [{ weight, style: 'normal' }] });
}

const injected = new Set<string>();

/** Loads a family's (canonical) stylesheet once for previews (browser only; no-op elsewhere). */
export function ensureFontPreview(family: string): void {
  if (typeof document === 'undefined' || injected.has(family)) return;
  injected.add(family);
  void loadFontStylesheet(fontPreviewCssUrl(family));
}
