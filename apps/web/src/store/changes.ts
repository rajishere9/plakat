/**
 * Change detection between two document snapshots. immer's structural sharing makes
 * a reference diff exact and cheap: an element/page object that is `===` did not change.
 * (Patch paths are positional and shift with inserts/removals, so they are not used
 * to identify elements.)
 */
import { jsonEqual, type Id, type Page, type PlakatDocument, type PlakatElement, type TextElement } from '@plakat/schema';

export type ChangeSource = 'commit' | 'undo' | 'redo' | 'load';

/**
 * What changed in the last document update. The canvas reconciles with
 * `scene.update(doc, { dirty: change.ids })` for every page in `change.pages`,
 * rebuilds all scenes when `change.full`, and (after the font barrier) passes
 * `rebuildText` for text whose face or characters changed.
 */
export interface DocumentChange {
  /** Monotonic counter (1, 2, 3 ...) per store. */
  seq: number;
  source: ChangeSource;
  /** History label ('Move', 'Delete', ...), '' for loads. */
  label: string;
  /** Element ids added, removed or modified (any page), plus explicitly `touched` ids. */
  ids: Id[];
  added: Id[];
  removed: Id[];
  /** Pages whose object changed (elements, background, name) or that were added. */
  pages: Id[];
  pagesAdded: Id[];
  pagesRemoved: Id[];
  /** Page order or count changed. */
  pageOrderChanged: boolean;
  /** `doc.size` changed (every scene must re-apply size). */
  sizeChanged: boolean;
  assetsChanged: boolean;
  metaChanged: boolean;
  templateChanged: boolean;
  /**
   * Text elements (added or modified) whose font face (family/weight/style) or
   * rendered characters (content/textTransform) changed: run the font barrier for
   * them, then `scene.update(doc, { rebuildText })` if a face/subset finished loading late.
   */
  rebuildText: Id[];
  /** A new document was loaded: rebuild everything. */
  full: boolean;
}

const textFaceChanged = (a: TextElement, b: TextElement) =>
  a.fontFamily !== b.fontFamily ||
  a.fontWeight !== b.fontWeight ||
  a.fontStyle !== b.fontStyle ||
  a.content !== b.content ||
  a.textTransform !== b.textTransform;

export function diffDocuments(
  prev: PlakatDocument,
  next: PlakatDocument,
  extra: { seq: number; source: ChangeSource; label: string; touched?: Iterable<Id> },
): DocumentChange {
  const ids = new Set<Id>(extra.touched ?? []);
  const added: Id[] = [];
  const removed: Id[] = [];
  const pages: Id[] = [];
  const pagesAdded: Id[] = [];
  const pagesRemoved: Id[] = [];
  const rebuildText: Id[] = [];

  const prevPages = new Map<Id, Page>(prev.pages.map((p) => [p.id, p]));
  const prevElements = new Map<Id, PlakatElement>();
  for (const p of prev.pages) for (const e of p.elements) prevElements.set(e.id, e);
  const nextElementIds = new Set<Id>();

  for (const page of next.pages) {
    for (const e of page.elements) nextElementIds.add(e.id);
    const before = prevPages.get(page.id);
    if (before === page) continue;
    pages.push(page.id);
    if (!before) pagesAdded.push(page.id);
    for (const el of page.elements) {
      const old = prevElements.get(el.id);
      if (old === el) continue;
      ids.add(el.id);
      if (!old) added.push(el.id);
      if (el.type === 'text' && (!old || old.type !== 'text' || textFaceChanged(old, el))) rebuildText.push(el.id);
    }
  }
  for (const [id] of prevElements) {
    if (!nextElementIds.has(id)) {
      ids.add(id);
      removed.push(id);
    }
  }
  const nextPageIds = new Set(next.pages.map((p) => p.id));
  for (const p of prev.pages) if (!nextPageIds.has(p.id)) pagesRemoved.push(p.id);
  const pageOrderChanged =
    prev.pages.length !== next.pages.length || prev.pages.some((p, i) => p.id !== next.pages[i]?.id);

  return {
    seq: extra.seq,
    source: extra.source,
    label: extra.label,
    ids: [...ids],
    added,
    removed,
    pages,
    pagesAdded,
    pagesRemoved,
    pageOrderChanged,
    sizeChanged: prev.size !== next.size,
    assetsChanged: prev.assets !== next.assets,
    metaChanged: prev.meta !== next.meta,
    templateChanged: prev.template !== next.template || prev.kind !== next.kind,
    rebuildText,
    full: false,
  };
}

/** The change record for a freshly loaded document. */
export function fullChange(doc: PlakatDocument, seq: number): DocumentChange {
  const ids = doc.pages.flatMap((p) => p.elements.map((e) => e.id));
  return {
    seq,
    source: 'load',
    label: '',
    ids,
    added: ids,
    removed: [],
    pages: doc.pages.map((p) => p.id),
    pagesAdded: doc.pages.map((p) => p.id),
    pagesRemoved: [],
    pageOrderChanged: true,
    sizeChanged: true,
    assetsChanged: true,
    metaChanged: true,
    templateChanged: true,
    rebuildText: doc.pages.flatMap((p) => p.elements.filter((e) => e.type === 'text').map((e) => e.id)),
    full: true,
  };
}

// ---------------------------------------------------------------------------
// Reconcile a pure helper's result into an immer draft (fine-grained patches)
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Writes `next` into `draft` (a draft of `base`) touching only what differs by
 * reference, so the recorded patches stay small and untouched subtrees keep their
 * identity. Pure schema helpers (removeElements, applyBrandKit, ...) return documents
 * that share unchanged subtrees with their input; reconciling them yields the same
 * patches a hand-written mutation would. Arrays of equal length are reconciled per
 * index; arrays whose length changed are replaced wholesale.
 */
export function reconcileInto(draft: Record<string, unknown>, base: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(next, key)) delete draft[key];
  }
  for (const key of Object.keys(next)) {
    const nv = next[key];
    const bv = Object.hasOwn(base, key) ? base[key] : undefined;
    if (nv === bv) continue;
    if (isPlainObject(nv) && isPlainObject(bv)) {
      reconcileInto(draft[key] as Record<string, unknown>, bv, nv);
    } else if (Array.isArray(nv) && Array.isArray(bv) && nv.length === bv.length) {
      reconcileArray(draft[key] as unknown[], bv, nv);
    } else {
      draft[key] = nv;
    }
  }
}

function reconcileArray(draft: unknown[], base: unknown[], next: unknown[]): void {
  for (let i = 0; i < next.length; i++) {
    const nv = next[i];
    const bv = base[i];
    if (nv === bv) continue;
    if (isPlainObject(nv) && isPlainObject(bv) && sameIdentity(nv, bv)) {
      reconcileInto(draft[i] as Record<string, unknown>, bv, nv);
    } else if (Array.isArray(nv) && Array.isArray(bv) && nv.length === bv.length) {
      reconcileArray(draft[i] as unknown[], bv, nv);
    } else {
      draft[i] = nv;
    }
  }
}

/** Items with ids (pages, elements, slots) are only patched in place when the id matches. */
function sameIdentity(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return !('id' in a) || !('id' in b) || a['id'] === b['id'];
}

// ---------------------------------------------------------------------------
// Identity restoration after applyPatches
// ---------------------------------------------------------------------------

/**
 * immer's applyPatches deep-clones every object value carried by a patch, so after
 * undo/redo unchanged elements can come back as new (deep-equal) objects. This puts
 * the `base` objects back wherever the content is equal, so reference diffs stay exact
 * (the canvas only re-applies what really changed) and memory stays shared.
 */
export function restoreSharing(base: PlakatDocument, next: PlakatDocument): PlakatDocument {
  if (base === next) return base;
  const basePages = new Map(base.pages.map((p) => [p.id, p] as const));
  const baseEls = new Map<Id, PlakatElement>();
  for (const p of base.pages) for (const e of p.elements) baseEls.set(e.id, e);

  let pagesChanged = next.pages.length !== base.pages.length;
  const pages = next.pages.map((page, i) => {
    const bp = basePages.get(page.id);
    if (bp === page) {
      if (base.pages[i] !== page) pagesChanged = true;
      return page;
    }
    const elements = page.elements.map((e) => {
      const be = baseEls.get(e.id);
      return be && be !== e && jsonEqual(be, e) ? be : e;
    });
    const sameEls = !!bp && elements.length === bp.elements.length && elements.every((e, k) => e === bp.elements[k]);
    if (bp && sameEls && bp.name === page.name && jsonEqual(bp.background, page.background)) {
      if (base.pages[i] !== bp) pagesChanged = true;
      return bp;
    }
    pagesChanged = true;
    const elementsArr = elements.every((e, k) => e === page.elements[k]) ? page.elements : Object.freeze(elements);
    return elementsArr === page.elements ? page : Object.freeze({ ...page, elements: elementsArr as PlakatElement[] });
  });

  const pick = <K extends keyof PlakatDocument>(k: K): PlakatDocument[K] => (next[k] === base[k] || jsonEqual(next[k], base[k]) ? base[k] : next[k]);
  let assets = next.assets;
  if (assets !== base.assets) {
    if (jsonEqual(assets, base.assets)) assets = base.assets;
    else {
      const out: Record<Id, PlakatDocument['assets'][string]> = {};
      let reused = false;
      for (const [id, a] of Object.entries(assets)) {
        const b = Object.hasOwn(base.assets, id) ? base.assets[id] : undefined;
        if (b && b !== a && jsonEqual(a, b)) {
          out[id] = b;
          reused = true;
        } else out[id] = a;
      }
      if (reused) assets = Object.freeze(out);
    }
  }
  const result: PlakatDocument = {
    ...next,
    meta: pick('meta'),
    size: pick('size'),
    fonts: pick('fonts'),
    template: pick('template'),
    assets,
    pages: pagesChanged ? pages : base.pages,
  };
  const keys = Object.keys(result) as (keyof PlakatDocument)[];
  if (keys.length === Object.keys(base).length && keys.every((k) => result[k] === base[k])) return base;
  return Object.freeze(result);
}
