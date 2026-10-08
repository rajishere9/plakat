/**
 * Selectors for `useEditor(selector)`. All return referentially stable values for
 * unchanged inputs (zustand 5 re-renders, and warns, on unstable selector results).
 */
import {
  getSelectionBounds,
  slotsByElement,
  transformerConstraints,
  type Asset,
  type BrandKit,
  type Id,
  type Page,
  type PlakatElement,
  type Rect,
  type TemplateSlot,
} from '@plakat/schema';
import type { EditorState } from './types.ts';

function memo<A, B, R>(fn: (a: A, b: B) => R): (a: A, b: B) => R {
  let la: A | typeof UNSET = UNSET;
  let lb: B | typeof UNSET = UNSET;
  let lr: R;
  return (a, b) => {
    if (a !== la || b !== lb) {
      lr = fn(a, b);
      la = a;
      lb = b;
    }
    return lr;
  };
}
const UNSET = Symbol('unset');

export const selectDocument = (s: EditorState) => s.document;
export const selectActions = (s: EditorState) => s.actions;

export const selectActivePage = (s: EditorState): Page => s.document.pages.find((p) => p.id === s.activePageId) ?? s.document.pages[0]!;
export const selectActivePageIndex = (s: EditorState): number => Math.max(0, s.document.pages.findIndex((p) => p.id === s.activePageId));

const selectedElementsMemo = memo((pages: Page[], ids: Id[]): PlakatElement[] => {
  const all = new Map<Id, PlakatElement>();
  for (const p of pages) for (const e of p.elements) all.set(e.id, e);
  return ids.map((id) => all.get(id)).filter((e): e is PlakatElement => !!e);
});
/** Selected elements in selection order. */
export const selectSelectedElements = (s: EditorState): PlakatElement[] => selectedElementsMemo(s.document.pages, s.selectedIds);

const boundsMemo = memo((els: PlakatElement[], _unused: null): Rect | null => getSelectionBounds(els));
/** Union AABB of the selection (page px), null when empty. */
export const selectSelectionBounds = (s: EditorState): Rect | null => boundsMemo(selectSelectedElements(s), null);

const transformerMemo = memo((els: PlakatElement[], _unused: null) => transformerConstraints(els.filter((e) => !e.locked)));
/** Konva Transformer config for the current selection (keepRatio, enabledAnchors, flipEnabled). */
export const selectTransformerConfig = (s: EditorState) => transformerMemo(selectSelectedElements(s), null);

/** 'text' | 'shape' | 'image' when every selected element has that type, 'mixed', or null when empty. */
export const selectSelectionType = (s: EditorState): PlakatElement['type'] | 'mixed' | null => {
  const els = selectSelectedElements(s);
  if (!els.length) return null;
  const t = els[0]!.type;
  return els.every((e) => e.type === t) ? t : 'mixed';
};

/** Element by id (any page). */
export const selectElement =
  (id: Id | null | undefined) =>
  (s: EditorState): PlakatElement | undefined => {
    if (!id) return undefined;
    for (const p of s.document.pages) {
      const e = p.elements.find((x) => x.id === id);
      if (e) return e;
    }
    return undefined;
  };

export const selectAsset =
  (assetId: Id | null | undefined) =>
  (s: EditorState): Asset | undefined =>
    assetId && Object.hasOwn(s.document.assets, assetId) ? s.document.assets[assetId] : undefined;

export const selectIsTemplate = (s: EditorState) => s.document.kind === 'template';

const slotsMemo = memo((template: EditorState['document']['template'], _unused: null) =>
  slotsByElement({ template } as EditorState['document']),
);
/** Element id -> slots targeting it (empty map for designs). */
export const selectSlotsByElement = (s: EditorState): Map<Id, TemplateSlot[]> => slotsMemo(s.document.template, null);

export const selectActiveBrandKit = (s: EditorState): BrandKit | undefined =>
  s.brandKits.find((k) => k.id === s.activeBrandKitId) ?? s.brandKits[0];

export const selectHasUnsavedChanges = (s: EditorState) => s.docRevision !== s.savedRevision;

export const selectIsSelected = (id: Id) => (s: EditorState) => s.selectedIds.includes(id);

/** Layers-panel label: name, else first text line, else a type label. */
export function getElementLabel(el: PlakatElement): string {
  if (el.name) return el.name;
  if (el.type === 'text') {
    const line = el.content.split('\n')[0]?.trim() ?? '';
    return line ? (line.length > 40 ? `${line.slice(0, 39)}…` : line) : 'Text';
  }
  if (el.type === 'image') return 'Image';
  const names: Record<string, string> = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', triangle: 'Triangle', polygon: 'Polygon', star: 'Star' };
  return names[el.shape] ?? 'Shape';
}
