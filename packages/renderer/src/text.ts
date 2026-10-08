import type { Text as KonvaText } from 'konva/lib/shapes/Text';

/**
 * Width of the widest grapheme of a text node's (transformed) text, per §3.3:
 * max over distinct graphemes g of `measureSize(g).width + letterSpacingPx`.
 * The text node must already carry its final font attributes and letterSpacing.
 *
 * Results are cached per (context font, grapheme). The cache MUST be invalidated when
 * fonts finish loading (a measurement taken with a fallback font is wrong afterwards):
 * prepareResources() and PageScene.update(.., { rebuildText }) do this through
 * invalidateTextMeasurements().
 */
const measureCache = new Map<string, Map<string, number>>();

let segmenter: Intl.Segmenter | null | undefined;
function graphemes(text: string): Iterable<string> {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  if (!segmenter) return Array.from(text);
  const seg = segmenter;
  return (function* () {
    for (const s of seg.segment(text)) yield s.segment;
  })();
}

/** Drops all cached grapheme widths (call after any font finished loading). */
export function invalidateTextMeasurements(): void {
  measureCache.clear();
}

export function widestGraphemeWidth(node: KonvaText, text: string, letterSpacingPx: number): number {
  const font = (node as unknown as { _getContextFont(): string })._getContextFont();
  let perFont = measureCache.get(font);
  if (!perFont) measureCache.set(font, (perFont = new Map()));
  let widest = 0;
  const seen = new Set<string>();
  for (const g of graphemes(text)) {
    if (seen.has(g)) continue;
    seen.add(g);
    // Hard breaks are split off by Konva before wrapping; never measured as a glyph.
    if (/^[\r\n]+$/.test(g)) continue;
    let w = perFont.get(g);
    if (w === undefined) {
      w = node.measureSize(g).width;
      perFont.set(g, w);
    }
    widest = Math.max(widest, w + letterSpacingPx);
  }
  return widest;
}

// ---------------------------------------------------------------------------
// Bidi base direction (§3.3)
// ---------------------------------------------------------------------------

/** Characters of right-to-left scripts (bidi class R / AL) and the RLM / ALM marks. */
const RTL_CHAR =
  /[‏؜\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}\p{Script=Mende_Kikakui}\p{Script=Imperial_Aramaic}\p{Script=Phoenician}\p{Script=Avestan}\p{Script=Kharoshthi}\p{Script=Old_South_Arabian}\p{Script=Old_North_Arabian}\p{Script=Nabataean}\p{Script=Palmyrene}\p{Script=Hatran}\p{Script=Manichaean}\p{Script=Psalter_Pahlavi}\p{Script=Inscriptional_Pahlavi}\p{Script=Inscriptional_Parthian}\p{Script=Old_Hungarian}\p{Script=Sogdian}\p{Script=Old_Sogdian}\p{Script=Elymaic}\p{Script=Chorasmian}\p{Script=Lydian}\p{Script=Cypriot}\p{Script=Old_Uyghur}]/u;
/** A strong-direction candidate: letters (minus RTL-script marks/digits, which are not \p{L}) and the LRM/RLM/ALM marks. */
const STRONG_CHAR = /[\p{L}‎‏؜]/u;

/**
 * Base direction of a text element: the direction of its first strong character, like
 * HTML `dir="auto"` (the inline editor's textarea uses dir="auto" too). Text without a
 * strong character (digits, punctuation, empty) is 'ltr'.
 */
export function textBaseDirection(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    if (!STRONG_CHAR.test(ch)) continue;
    return RTL_CHAR.test(ch) ? 'rtl' : 'ltr';
  }
  return 'ltr';
}

/**
 * Cursive (joining) scripts. Browsers do not apply letter-spacing to them (it would break
 * the joins; CSS Text 3 §8.2), but Konva still counts it into line widths, which would
 * shift aligned text. So the renderer does not apply letterSpacing to text containing them.
 */
const CURSIVE_CHAR = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mandaic}\p{Script=Mongolian}\p{Script=Hanifi_Rohingya}\p{Script=Adlam}\p{Script=Psalter_Pahlavi}\p{Script=Manichaean}\p{Script=Sogdian}\p{Script=Old_Uyghur}]/u;

/** True when the text contains any right-to-left character. */
export function containsRtl(text: string): boolean {
  return RTL_CHAR.test(text);
}

export interface TextLayoutAttrs {
  /** Konva `direction`: always explicit, never 'inherit' (an inherited DOM direction would differ between editor and export). */
  direction: 'ltr' | 'rtl';
  /** Konva `align`. */
  align: 'left' | 'center' | 'right' | 'justify';
  /** Konva `letterSpacing` in px. */
  letterSpacing: number;
}

/**
 * Konva text attributes that keep right-to-left scripts intact (§3.3).
 *
 * Konva draws text grapheme by grapheme, left to right, whenever letterSpacing != 0 or
 * align is 'justify' and its direction is not 'rtl'. That mirrors Hebrew and leaves
 * Arabic unshaped. So:
 *  - RTL base direction (first strong character): Konva direction 'rtl', which keeps one
 *    native run per line (letterSpacing via ctx.letterSpacing). Konva cannot justify an
 *    RTL run, so 'justify' falls back to 'right' (the start edge of RTL text). Text with a
 *    cursive script (Arabic, …) gets no letterSpacing: browsers do not apply it to those
 *    scripts, and Konva would still add it to the measured line width (misaligned text).
 *  - LTR base direction with RTL characters inside: the per-grapheme path would reverse
 *    the RTL words, so letterSpacing and justify are dropped (one native run, 'left').
 *  - Everything else: unchanged.
 */
export function textLayoutAttrs(text: string, align: TextLayoutAttrs['align'], letterSpacingPx: number): TextLayoutAttrs {
  const direction = textBaseDirection(text);
  if (direction === 'rtl') {
    return { direction, align: align === 'justify' ? 'right' : align, letterSpacing: CURSIVE_CHAR.test(text) ? 0 : letterSpacingPx };
  }
  if ((letterSpacingPx !== 0 || align === 'justify') && containsRtl(text)) {
    return { direction, align: align === 'justify' ? 'left' : align, letterSpacing: 0 };
  }
  return { direction, align, letterSpacing: letterSpacingPx };
}
