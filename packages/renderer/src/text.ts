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
