import type { FontStyle, FontVariant, FontWeight } from './types.ts';

export type FontCategory = 'sans-serif' | 'serif' | 'display' | 'handwriting' | 'monospace';

/** What Google Fonts actually serves for a family. Requesting anything else returns HTTP 400. */
export interface GoogleFontInfo {
  family: string;
  category: FontCategory;
  /** Available upright weights (ascending, non-empty). */
  normal: readonly FontWeight[];
  /** Available italic weights (ascending; empty = no italic face). */
  italic: readonly FontWeight[];
}

const ALL: readonly FontWeight[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const range = (min: FontWeight, max: FontWeight): FontWeight[] => ALL.filter((w) => w >= min && w <= max);
const font = (
  family: string,
  category: FontCategory,
  normal: readonly FontWeight[],
  italic: readonly FontWeight[] | 'same' = 'same',
): GoogleFontInfo => ({ family, category, normal, italic: italic === 'same' ? normal : italic });
const R400: readonly FontWeight[] = [400];

/**
 * Curated Google Fonts catalog (family -> available weights / italics), used by the
 * editor's font picker, the Bold/Italic controls and brand-kit validation, and by
 * googleFontsCssUrl() to request only variants that exist. Families not listed are
 * still allowed (typed by hand); they are requested as-is with a per-variant
 * fallback (render-export-pipeline.md §3.1). Extend freely, keeping data exact.
 */
export const GOOGLE_FONTS_CATALOG: readonly GoogleFontInfo[] = [
  font('Inter', 'sans-serif', ALL),
  font('Roboto', 'sans-serif', ALL),
  font('Open Sans', 'sans-serif', range(300, 800)),
  font('Lato', 'sans-serif', [100, 300, 400, 700, 900]),
  font('Montserrat', 'sans-serif', ALL),
  font('Poppins', 'sans-serif', ALL),
  font('Raleway', 'sans-serif', ALL),
  font('Nunito', 'sans-serif', range(200, 900)),
  font('Source Sans 3', 'sans-serif', range(200, 900)),
  font('DM Sans', 'sans-serif', ALL),
  font('Work Sans', 'sans-serif', ALL),
  font('Rubik', 'sans-serif', range(300, 900)),
  font('Barlow', 'sans-serif', ALL),
  font('Karla', 'sans-serif', range(200, 800)),
  font('Josefin Sans', 'sans-serif', range(100, 700)),
  font('Fira Sans', 'sans-serif', ALL),
  font('IBM Plex Sans', 'sans-serif', range(100, 700)),
  font('Archivo', 'sans-serif', ALL),
  font('Libre Franklin', 'sans-serif', ALL),
  font('Noto Sans', 'sans-serif', ALL),
  font('Oswald', 'sans-serif', range(200, 700), []),
  font('Space Grotesk', 'sans-serif', range(300, 700), []),
  font('Quicksand', 'sans-serif', range(300, 700), []),
  font('Manrope', 'sans-serif', range(200, 800), []),
  font('Outfit', 'sans-serif', ALL, []),
  font('Comfortaa', 'display', range(300, 700), []),
  font('Playfair Display', 'serif', range(400, 900)),
  font('Merriweather', 'serif', [300, 400, 700, 900]),
  font('Lora', 'serif', range(400, 700)),
  font('PT Serif', 'serif', [400, 700]),
  font('Libre Baskerville', 'serif', [400, 700], [400]),
  font('Crimson Text', 'serif', [400, 600, 700]),
  font('Cormorant Garamond', 'serif', range(300, 700)),
  font('EB Garamond', 'serif', range(400, 800)),
  font('Bitter', 'serif', ALL),
  font('Space Mono', 'monospace', [400, 700]),
  font('Roboto Mono', 'monospace', range(100, 700)),
  font('Bebas Neue', 'display', R400, []),
  font('Anton', 'display', R400, []),
  font('Abril Fatface', 'display', R400, []),
  font('Archivo Black', 'display', R400, []),
  font('Alfa Slab One', 'display', R400, []),
  font('Lobster', 'display', R400, []),
  font('Righteous', 'display', R400, []),
  font('Fjalla One', 'display', R400, []),
  font('Pacifico', 'handwriting', R400, []),
  font('Permanent Marker', 'handwriting', R400, []),
  font('Great Vibes', 'handwriting', R400, []),
  font('Dancing Script', 'handwriting', range(400, 700), []),
  font('Caveat', 'handwriting', range(400, 700), []),
];

const BY_FAMILY = new Map(GOOGLE_FONTS_CATALOG.map((f) => [f.family.toLowerCase(), f] as const));

/** Catalog entry for a family (case-insensitive), or undefined for uncatalogued families. */
export function getFontInfo(family: string): GoogleFontInfo | undefined {
  return BY_FAMILY.get(family.toLowerCase());
}

/** CSS Fonts 4 weight matching: the available weight a browser would pick for `desired`. */
export function matchFontWeight(desired: number, available: readonly FontWeight[]): FontWeight {
  if (available.length === 0) throw new RangeError('No weights available');
  if (available.includes(desired as FontWeight)) return desired as FontWeight;
  const below = available.filter((w) => w < desired).sort((a, b) => b - a);
  const above = available.filter((w) => w > desired).sort((a, b) => a - b);
  if (desired >= 400 && desired <= 500) {
    const upTo500 = above.filter((w) => w <= 500);
    if (upTo500.length) return upTo500[0]!;
    return (below[0] ?? above[0])!;
  }
  if (desired < 400) return (below[0] ?? above[0])!;
  return (above[0] ?? below[0])!;
}

/**
 * The variant Google Fonts can actually serve for (weight, style), as the browser
 * would match it: italic falls back to upright (synthesized oblique), weights to the
 * nearest available (synthesized bold above). Uncatalogued families pass through.
 */
export function resolveFontVariant(family: string, weight: FontWeight, style: FontStyle): FontVariant {
  const info = getFontInfo(family);
  if (!info) return { weight, style };
  const useItalic = style === 'italic' && info.italic.length > 0;
  const weights = useItalic ? info.italic : info.normal;
  return { weight: matchFontWeight(weight, weights), style: useItalic ? 'italic' : 'normal' };
}

/** Whether the exact variant exists (true for uncatalogued families: unknown, assumed yes). */
export function hasFontVariant(family: string, weight: FontWeight, style: FontStyle): boolean {
  const info = getFontInfo(family);
  if (!info) return true;
  return (style === 'italic' ? info.italic : info.normal).includes(weight);
}
