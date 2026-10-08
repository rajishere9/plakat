/**
 * Text mapping details (§3.3): bidi base direction (RTL scripts must never take Konva's
 * per-grapheme LTR path) and element opacity applied once to the finished text.
 */
import { createTestEnv, makeDoc, page, rgba, text } from './test-support.ts';
import { describe, expect, it } from 'vitest';
import { customPageSize, type PlakatDocument, type TextElement } from '@plakat/schema';
import { SceneCanvas } from 'konva/lib/Canvas';
import { Konva, type KonvaText } from './konva.ts';
import { prepareResources } from './resources.ts';
import { renderPageCanvas } from './export.ts';
import { PageScene } from './scene.ts';
import { containsRtl, textBaseDirection, textLayoutAttrs } from './text.ts';

const env = createTestEnv();

const HEBREW = 'שלום עולם יפה';
const ARABIC = 'مرحبا بالعالم';

describe('bidi base direction', () => {
  it('is the direction of the first strong character (dir="auto")', () => {
    expect(textBaseDirection(HEBREW)).toBe('rtl');
    expect(textBaseDirection(ARABIC)).toBe('rtl');
    expect(textBaseDirection('2024 — שלום')).toBe('rtl');
    expect(textBaseDirection('Hello שלום')).toBe('ltr');
    expect(textBaseDirection('‏abc')).toBe('rtl');
    expect(textBaseDirection('Ἀθῆναι Москва 日本語')).toBe('ltr');
    expect(textBaseDirection('123 !?')).toBe('ltr');
    expect(textBaseDirection('')).toBe('ltr');
    expect(containsRtl('Hello שלום')).toBe(true);
    expect(containsRtl('Hello')).toBe(false);
  });

  it('maps to Konva attributes that keep RTL text in one native run', () => {
    expect(textLayoutAttrs(HEBREW, 'left', 2)).toEqual({ direction: 'rtl', align: 'left', letterSpacing: 2 });
    expect(textLayoutAttrs(ARABIC, 'justify', 0)).toEqual({ direction: 'rtl', align: 'right', letterSpacing: 0 });
    // cursive scripts: browsers ignore letter-spacing, so it must not count into line widths either
    expect(textLayoutAttrs(ARABIC, 'right', 2)).toEqual({ direction: 'rtl', align: 'right', letterSpacing: 0 });
    // LTR paragraph with an RTL word: spacing/justify would reverse the word, so they are dropped
    expect(textLayoutAttrs('Hello שלום', 'justify', 3)).toEqual({ direction: 'ltr', align: 'left', letterSpacing: 0 });
    expect(textLayoutAttrs('Hello שלום', 'center', 0)).toEqual({ direction: 'ltr', align: 'center', letterSpacing: 0 });
    // plain LTR text is untouched
    expect(textLayoutAttrs('Hello', 'justify', 3)).toEqual({ direction: 'ltr', align: 'justify', letterSpacing: 3 });
  });
});

async function sceneFor(doc: PlakatDocument) {
  const resources = await prepareResources(doc, undefined, env, { allowFallbackFonts: true });
  return new PageScene({ doc, pageId: doc.pages[0]!.id, resources, pixelRatio: 1 });
}

/** Draws the scene and records every fillText the canvas receives. */
function recordFillText(scene: PageScene): { text: string; direction: string }[] {
  const canvas = new SceneCanvas({ width: 600, height: 300, pixelRatio: 1 });
  const raw = canvas.getContext()._context;
  const calls: { text: string; direction: string }[] = [];
  const original = raw.fillText.bind(raw);
  raw.fillText = (t: string, x: number, y: number, maxWidth?: number) => {
    calls.push({ text: t, direction: raw.direction });
    return maxWidth === undefined ? original(t, x, y) : original(t, x, y, maxWidth);
  };
  scene.root.drawScene(canvas, scene.root);
  Konva.Util.releaseCanvas(canvas._canvas);
  return calls;
}

describe('RTL text is drawn as one native run per line (never per grapheme)', () => {
  const cases: [string, string, Partial<TextElement>][] = [
    ['Hebrew + letterSpacing', HEBREW, { letterSpacing: 0.02 }],
    ['Hebrew + justify', HEBREW, { align: 'justify' }],
    ['Arabic + letterSpacing', ARABIC, { letterSpacing: 0.02 }],
    ['Arabic + justify', ARABIC, { align: 'justify' }],
    ['Arabic, negative spacing', ARABIC, { letterSpacing: -0.05 }],
  ];
  for (const [label, content, patch] of cases) {
    it(label, async () => {
      const doc = makeDoc(customPageSize(600, 300), [page('pg_1', [text('el_t', { x: 10, y: 10, width: 580, height: 100, fontSize: 40, content, ...patch })])]);
      const scene = await sceneFor(doc);
      const node = scene.getElementNode('el_t')!.getChildren()[1] as KonvaText;
      expect(node.direction()).toBe('rtl');
      expect(recordFillText(scene)).toEqual([{ text: content, direction: 'rtl' }]);
      scene.destroy();
    });
  }

  it('an LTR paragraph with an RTL word keeps the word intact when spacing is set', async () => {
    const content = 'Hello שלום world';
    const doc = makeDoc(customPageSize(600, 300), [page('pg_1', [text('el_t', { x: 10, y: 10, width: 580, height: 100, fontSize: 40, content, letterSpacing: 0.1 })])]);
    const scene = await sceneFor(doc);
    expect(recordFillText(scene)).toEqual([{ text: content, direction: 'ltr' }]);
    scene.destroy();
  });

  it('LTR text keeps the per-grapheme path for letterSpacing (unchanged)', async () => {
    const doc = makeDoc(customPageSize(600, 300), [page('pg_1', [text('el_t', { x: 10, y: 10, width: 580, height: 100, fontSize: 40, content: 'Abc', letterSpacing: 0.1 })])]);
    const scene = await sceneFor(doc);
    expect(recordFillText(scene)).toEqual(['A', 'b', 'c'].map((t) => ({ text: t, direction: 'ltr' })));
    scene.destroy();
  });

  it('direction is explicit, so an inherited (DOM) rtl canvas cannot change LTR text', async () => {
    const doc = makeDoc(customPageSize(600, 300), [page('pg_1', [text('el_t', { x: 10, y: 10, width: 580, height: 100, content: 'Abc' })])]);
    const scene = await sceneFor(doc);
    expect((scene.getElementNode('el_t')!.getChildren()[1] as KonvaText).direction()).toBe('ltr');
    scene.destroy();
  });
});

describe('element opacity applies once to the finished text (CSS-like), not per draw call', () => {
  /** Max alpha over a transparent page with black text at opacity 0.5. */
  async function maxAlpha(patch: Partial<TextElement> & { content: string }): Promise<number> {
    const doc = makeDoc(customPageSize(400, 300), [
      page('pg_1', [text('el_t', { x: 20, y: 40, width: 360, height: 200, fontSize: 100, fill: '#000000', opacity: 0.5, ...patch })], { color: null, image: null }),
    ]);
    const r = await renderPageCanvas(doc, 'pg_1', { scale: 1, env });
    const px = rgba(r.canvas);
    r.release();
    let max = 0;
    for (let i = 3; i < px.length; i += 4) max = Math.max(max, px[i]!);
    return max;
  }

  it('overlapping lines (lineHeight < 1) do not darken', async () => {
    expect(await maxAlpha({ content: 'Hg\nHg', lineHeight: 0.5 })).toBeLessThanOrEqual(128);
  });

  it('overlapping glyphs (negative letterSpacing) do not darken', async () => {
    expect(await maxAlpha({ content: 'WWW', letterSpacing: -0.3 })).toBeLessThanOrEqual(128);
  });

  it('opaque text is not isolated (no extra buffer)', async () => {
    const doc = makeDoc(customPageSize(400, 300), [page('pg_1', [text('el_a', { content: 'a' }), text('el_b', { content: 'b', opacity: 0.4 })])]);
    const scene = await sceneFor(doc);
    expect(scene.getElementNode('el_a')!.getAttr('isolated')).toBe(false);
    expect(scene.getElementNode('el_b')!.getAttr('isolated')).toBe(true);
    scene.destroy();
  });
});
