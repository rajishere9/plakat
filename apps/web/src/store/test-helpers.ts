/** Test utilities (imported by *.test.ts only). */
import { createDocument, createShapeElement, createTextElement, type PlakatDocument, type PlakatElement } from '@plakat/schema';
import { createEditorStore, type EditorStore } from './editor-store.ts';

export interface TestClock {
  now: () => number;
  advance(ms: number): void;
}

export function testClock(start = 1_000_000): TestClock {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

/** 1000x1000 custom page document with the given elements on page 1. */
export function docWith(elements: PlakatElement[] = [], pageCount = 1): PlakatDocument {
  const doc = createDocument({ width: 1000, height: 1000, presetId: null, physical: null }, { pageCount });
  doc.pages[0]!.elements = elements;
  return doc;
}

export function rect(id: string, x: number, y: number, w: number, h: number, extra: Partial<PlakatElement> = {}): PlakatElement {
  return createShapeElement('rect', { id, x, y, width: w, height: h, ...(extra as object) });
}

export function text(id: string, x = 0, y = 0, extra: Partial<PlakatElement> = {}): PlakatElement {
  return createTextElement({ id, x, y, width: 200, height: 40, content: 'Hello', ...(extra as object) });
}

export function makeStore(elements: PlakatElement[] = [], opts: { pageCount?: number; clock?: TestClock } = {}): { store: EditorStore; clock: TestClock } {
  const clock = opts.clock ?? testClock();
  const store = createEditorStore({ document: docWith(elements, opts.pageCount), now: clock.now });
  return { store, clock };
}

export const page0 = (store: EditorStore) => store.getState().document.pages[0]!;
export const el = (store: EditorStore, id: string) => {
  for (const p of store.getState().document.pages) {
    const e = p.elements.find((x) => x.id === id);
    if (e) return e;
  }
  throw new Error(`no element ${id}`);
};
