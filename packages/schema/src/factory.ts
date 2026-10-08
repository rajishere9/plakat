import { DEFAULT_FONT_FAMILY, syncFonts } from './fonts.ts';
import { createId, deepCopy, jsonEqual } from './ids.ts';
import { getElementBounds, moveBoundsTo } from './geometry.ts';
import { DEFAULT_PRESET_ID, presetToPageSize, type PresetId } from './presets.ts';
import {
  DOCUMENT_FORMAT,
  type Asset,
  type DocumentKind,
  type ElementBase,
  type PlakatElement,
  type Id,
  type ImageAsset,
  type ImageElement,
  type ImageFilters,
  type Page,
  type PageSize,
  type PlakatDocument,
  type ShapeElement,
  type ShapeKind,
  type TemplateInfo,
  type TemplateSlot,
  type TextElement,
} from './types.ts';
import { CURRENT_SCHEMA_VERSION } from './version.ts';

export interface FactoryOptions {
  /** Clock override (tests). */
  now?: () => Date;
}

const nowIso = (opts?: FactoryOptions) => (opts?.now?.() ?? new Date()).toISOString();

export const DEFAULT_FILTERS: Readonly<ImageFilters> = Object.freeze({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  blur: 0,
  grayscale: false,
  sepia: false,
  invert: false,
});

export interface CreateDocumentOptions extends FactoryOptions {
  title?: string;
  kind?: DocumentKind;
  /** Number of blank pages (default 1). */
  pageCount?: number;
}

/** New empty document from a preset id or an explicit PageSize. */
export function createDocument(
  size: PresetId | PageSize = DEFAULT_PRESET_ID,
  options: CreateDocumentOptions = {},
): PlakatDocument {
  if (CURRENT_SCHEMA_VERSION !== 1) throw new Error('factory.ts must be updated for the new schemaVersion');
  const ts = nowIso(options);
  const kind = options.kind ?? 'design';
  const pageCount = Math.max(1, options.pageCount ?? 1);
  return {
    format: DOCUMENT_FORMAT,
    schemaVersion: 1,
    kind,
    id: createId('doc'),
    meta: {
      title: options.title ?? (kind === 'template' ? 'Untitled template' : 'Untitled design'),
      description: '',
      tags: [],
      createdAt: ts,
      updatedAt: ts,
      sourceTemplateId: null,
    },
    size: typeof size === 'string' ? presetToPageSize(size) : deepCopy(size),
    pages: Array.from({ length: pageCount }, () => createPage()),
    assets: {},
    fonts: [],
    template: kind === 'template' ? { category: null, slots: [] } : null,
  };
}

export function createPage(partial: Partial<Omit<Page, 'id'>> = {}): Page {
  return {
    id: createId('pg'),
    name: partial.name ?? '',
    background: partial.background ? deepCopy(partial.background) : { color: '#ffffff', image: null },
    elements: partial.elements ?? [],
  };
}

/** Optional page context for element factories: defaults are then proportional to the page. */
export interface PlacementOptions {
  /** Page size; omitted = fixed defaults tuned for a 1080 px page. */
  page?: Pick<PageSize, 'width' | 'height'>;
}

/** Short side of the page (1080 when unknown): the unit for page-relative defaults. */
const pageUnit = (opts?: PlacementOptions) => (opts?.page ? Math.min(opts.page.width, opts.page.height) : null);

type BaseDefaults = Omit<ElementBase, 'id' | 'type'>;
const baseDefaults = (): BaseDefaults => ({
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  locked: false,
  hidden: false,
  groupId: null,
});

/**
 * Text element. With `{ page }`: fontSize = 6 % of the short page side (min 8 px),
 * width = 80 % of the page width; without: fontSize 32, width 400.
 */
export function createTextElement(partial: Partial<Omit<TextElement, 'type'>> = {}, opts: PlacementOptions = {}): TextElement {
  const unit = pageUnit(opts);
  const fontSize = partial.fontSize ?? (unit === null ? 32 : Math.max(8, Math.round(unit * 0.06)));
  const lineHeight = partial.lineHeight ?? 1.2;
  return {
    ...baseDefaults(),
    width: opts.page ? Math.round(opts.page.width * 0.8) : 400,
    height: Math.ceil(fontSize * lineHeight),
    content: 'Add a heading',
    fontFamily: DEFAULT_FONT_FAMILY,
    fontWeight: 400,
    fontStyle: 'normal',
    fontSize,
    lineHeight,
    letterSpacing: 0,
    align: 'left',
    verticalAlign: 'top',
    fill: '#000000',
    textDecoration: 'none',
    textTransform: 'none',
    ...partial,
    id: partial.id ?? createId('el'),
    type: 'text',
  };
}

/** Same default as ShapeElementSchema (`sides` is ignored by every kind except polygon/star). */
export const DEFAULT_SHAPE_SIDES = 5;

/**
 * Shape element. With `{ page }`: 30 % of the short page side (lines: 40 % of the
 * page width, stroke 0.4 % of the short side, min 1 px); without: 200 px / 300 px lines.
 */
export function createShapeElement(
  shape: ShapeKind,
  partial: Partial<Omit<ShapeElement, 'type' | 'shape'>> = {},
  opts: PlacementOptions = {},
): ShapeElement {
  const isLine = shape === 'line';
  const unit = pageUnit(opts);
  const side = unit === null ? 200 : Math.max(1, Math.round(unit * 0.3));
  const lineStroke = unit === null ? 4 : Math.max(1, Math.round(unit * 0.004));
  const lineLength = opts.page ? Math.max(1, Math.round(opts.page.width * 0.4)) : 300;
  return {
    ...baseDefaults(),
    width: isLine ? lineLength : side,
    height: isLine ? lineStroke : side,
    fill: isLine ? null : '#cccccc',
    stroke: isLine ? '#000000' : null,
    strokeWidth: isLine ? lineStroke : 0,
    dash: [],
    cornerRadius: 0,
    sides: DEFAULT_SHAPE_SIDES,
    innerRadius: 0.5,
    ...partial,
    id: partial.id ?? createId('el'),
    type: 'shape',
    shape,
  };
}

/**
 * Image element for an asset. Defaults to the asset's declared size scaled down to fit
 * within `maxSize` (default: 60 % of the short page side with `{ page }`, else 600 px),
 * preserving aspect ratio.
 */
export function createImageElement(
  assetId: Id,
  asset: Pick<ImageAsset, 'width' | 'height'> | null,
  partial: Partial<Omit<ImageElement, 'type' | 'assetId'>> & { maxSize?: number } = {},
  opts: PlacementOptions = {},
): ImageElement {
  const unit = pageUnit(opts);
  const { maxSize = unit === null ? 600 : unit * 0.6, ...rest } = partial;
  let width = Math.min(300, maxSize);
  let height = width;
  if (asset) {
    const k = Math.min(1, maxSize / Math.max(asset.width, asset.height));
    width = asset.width * k;
    height = asset.height * k;
  }
  return {
    ...baseDefaults(),
    width,
    height,
    crop: null,
    objectFit: 'cover',
    flipX: false,
    flipY: false,
    cornerRadius: 0,
    filters: { ...DEFAULT_FILTERS },
    ...rest,
    id: rest.id ?? createId('el'),
    type: 'image',
    assetId,
  };
}

/** New image asset record plus a fresh asset id. */
export function createImageAsset(
  fields: Pick<ImageAsset, 'src' | 'width' | 'height' | 'mimeType'> & Partial<Pick<ImageAsset, 'name' | 'source'>>,
): { id: Id; asset: Asset } {
  return {
    id: createId('as'),
    asset: {
      type: 'image',
      mimeType: fields.mimeType,
      width: fields.width,
      height: fields.height,
      src: fields.src,
      name: fields.name ?? '',
      source: fields.source ? deepCopy(fields.source) : null,
    },
  };
}

/**
 * Centers an element on the page, KEEPING its rotation: the rotated AABB is centered
 * (same rule as align-to-page). Returns a new element.
 */
export function centerOnPage<E extends PlakatElement>(el: E, size: Pick<PageSize, 'width' | 'height'>): E {
  const b = getElementBounds(el);
  return { ...el, ...moveBoundsTo(el, { x: (size.width - b.width) / 2, y: (size.height - b.height) / 2 }) };
}

// ---------------------------------------------------------------------------
// Cloning with fresh ids
// ---------------------------------------------------------------------------

/**
 * Old -> new ids produced by a clone, one map per namespace. (A single shared map
 * would corrupt the clone when, e.g., a slot id equals an element id.)
 */
export interface IdRemap {
  pages: Map<Id, Id>;
  elements: Map<Id, Id>;
  groups: Map<Id, Id>;
  slots: Map<Id, Id>;
}

export function createIdRemap(): IdRemap {
  return { pages: new Map(), elements: new Map(), groups: new Map(), slots: new Map() };
}

/**
 * Deep-clones elements with fresh element ids. groupIds are remapped consistently
 * through `remap.groups` (elements sharing a group in the input share a new group in
 * the output). Asset ids are kept: use importElements() to copy into ANOTHER document.
 * Safe on immer drafts (no structuredClone).
 */
export function cloneElementsWithNewIds(elements: readonly PlakatElement[], remap: IdRemap = createIdRemap()): PlakatElement[] {
  return elements.map((el) => {
    const copy = deepCopy(el);
    const newId = createId('el');
    remap.elements.set(el.id, newId);
    copy.id = newId;
    if (el.groupId) {
      let g = remap.groups.get(el.groupId);
      if (!g) remap.groups.set(el.groupId, (g = createId('grp')));
      copy.groupId = g;
    }
    return copy;
  });
}

/** Deep-clones a page with fresh page/element/group ids (asset ids kept). Safe on immer drafts. */
export function clonePageWithNewIds(page: Page, remap: IdRemap = createIdRemap()): Page {
  const newId = createId('pg');
  remap.pages.set(page.id, newId);
  return {
    id: newId,
    name: page.name,
    background: deepCopy(page.background),
    elements: cloneElementsWithNewIds(page.elements, remap),
  };
}

/**
 * Deep-clones a document regenerating the document id, page ids, element ids,
 * group ids and slot ids (slot targets remapped through `ids.elements`). Asset ids
 * are kept. Safe on immer drafts.
 */
export function cloneWithNewIds(doc: PlakatDocument): { document: PlakatDocument; ids: IdRemap } {
  const ids = createIdRemap();
  const pages = doc.pages.map((p) => clonePageWithNewIds(p, ids));
  const template: TemplateInfo | null = doc.template
    ? {
        category: doc.template.category,
        slots: doc.template.slots.map((slot): TemplateSlot => {
          const id = createId('slot');
          ids.slots.set(slot.id, id);
          return { ...deepCopy(slot), id, targets: slot.targets.map((t) => ids.elements.get(t) ?? t) };
        }),
      }
    : null;
  return {
    document: {
      format: doc.format,
      schemaVersion: doc.schemaVersion,
      kind: doc.kind,
      id: createId('doc'),
      meta: deepCopy(doc.meta),
      size: deepCopy(doc.size),
      pages,
      assets: deepCopy(doc.assets),
      fonts: deepCopy(doc.fonts),
      template,
    },
    ids,
  };
}

// ---------------------------------------------------------------------------
// Importing content between documents (asset-registry merge)
// ---------------------------------------------------------------------------

/**
 * Merges `incoming` asset records into `target`. An incoming id is kept when the
 * target lacks it or already holds a deep-equal record; an incoming record equal to
 * some other target record reuses that id; otherwise a fresh `as_` id is allocated.
 * Hand-written portable templates reuse readable ids (`as_logo`, `as_placeholder`),
 * so a plain `{ ...target, ...incoming }` would silently swap images.
 * `assetIdMap` lists only ids that changed (old -> new).
 */
export function mergeAssets(
  target: Readonly<Record<Id, Asset>>,
  incoming: Readonly<Record<Id, Asset>>,
): { assets: Record<Id, Asset>; assetIdMap: Map<Id, Id> } {
  const assets: Record<Id, Asset> = { ...target };
  const assetIdMap = new Map<Id, Id>();
  for (const [id, asset] of Object.entries(incoming)) {
    if (!Object.hasOwn(assets, id)) {
      assets[id] = deepCopy(asset);
      continue;
    }
    if (jsonEqual(assets[id], asset)) continue;
    const existing = Object.entries(assets).find(([, a]) => jsonEqual(a, asset));
    const newId = existing ? existing[0] : createId('as');
    if (!existing) assets[newId] = deepCopy(asset);
    assetIdMap.set(id, newId);
  }
  return { assets, assetIdMap };
}

/** Rewrites asset references (image elements and page backgrounds) through `map`. Pure. */
export function remapAssetRefs<T extends PlakatElement | Page>(item: T, map: ReadonlyMap<Id, Id>): T {
  if (map.size === 0) return item;
  if ('elements' in item) {
    const bg = item.background.image;
    return {
      ...item,
      background: bg && map.has(bg.assetId) ? { ...item.background, image: { assetId: map.get(bg.assetId)! } } : item.background,
      elements: item.elements.map((el) => remapAssetRefs(el, map)),
    };
  }
  if (item.type === 'image' && map.has(item.assetId)) return { ...item, assetId: map.get(item.assetId)! };
  return item;
}

function pickAssets(source: Readonly<Record<Id, Asset>>, ids: Iterable<Id>): Record<Id, Asset> {
  const out: Record<Id, Asset> = {};
  for (const id of ids) if (Object.hasOwn(source, id)) out[id] = source[id]!;
  return out;
}

export interface ImportOptions {
  /** Insert position (default: append). */
  index?: number;
}

/**
 * "Add page from template / another design": copies pages of `source` into `target`
 * with fresh page/element/group ids, merging the referenced assets (mergeAssets) and
 * rewriting references. Template slots are not imported. Returns the new page ids.
 */
export function importPages(
  target: PlakatDocument,
  source: Pick<PlakatDocument, 'pages' | 'assets'>,
  options: ImportOptions & { pageIds?: readonly Id[] } = {},
): { document: PlakatDocument; pageIds: Id[] } {
  const chosen = options.pageIds ? source.pages.filter((p) => options.pageIds!.includes(p.id)) : source.pages;
  const remap = createIdRemap();
  const cloned = chosen.map((p) => clonePageWithNewIds(p, remap));
  const { assets, assetIdMap } = mergeAssets(target.assets, pickAssets(source.assets, referencedAssetIds({ pages: chosen })));
  const pages = cloned.map((p) => remapAssetRefs(p, assetIdMap));
  const at = Math.min(Math.max(options.index ?? target.pages.length, 0), target.pages.length);
  const document = syncFonts({ ...target, assets, pages: [...target.pages.slice(0, at), ...pages, ...target.pages.slice(at)] });
  return { document, pageIds: pages.map((p) => p.id) };
}

/**
 * Paste / insert from another document or a brand kit: copies `source.elements` onto
 * page `pageId` of `target` with fresh element/group ids, merging referenced assets
 * (mergeAssets) and rewriting references. Returns the new element ids (same order).
 */
export function importElements(
  target: PlakatDocument,
  pageId: Id,
  source: { elements: readonly PlakatElement[]; assets: Readonly<Record<Id, Asset>> },
  options: ImportOptions = {},
): { document: PlakatDocument; elementIds: Id[] } {
  const pageIndex = target.pages.findIndex((p) => p.id === pageId);
  if (pageIndex === -1) throw new RangeError(`Unknown page "${pageId}"`);
  const refs = source.elements.flatMap((el) => (el.type === 'image' ? [el.assetId] : []));
  const { assets, assetIdMap } = mergeAssets(target.assets, pickAssets(source.assets, refs));
  const elements = cloneElementsWithNewIds(source.elements).map((el) => remapAssetRefs(el, assetIdMap));
  const page = target.pages[pageIndex]!;
  const at = Math.min(Math.max(options.index ?? page.elements.length, 0), page.elements.length);
  const nextPage: Page = { ...page, elements: [...page.elements.slice(0, at), ...elements, ...page.elements.slice(at)] };
  const pages = target.pages.map((p, i) => (i === pageIndex ? nextPage : p));
  return { document: syncFonts({ ...target, assets, pages }), elementIds: elements.map((e) => e.id) };
}

// ---------------------------------------------------------------------------
// Deleting (keeps template slots consistent)
// ---------------------------------------------------------------------------

/**
 * Drops slot targets that are not elements of the document, then slots left with
 * no target. Every delete path must go through this (removeElements/removePage do),
 * because a dangling target makes the document invalid.
 */
export function pruneSlotTargets(doc: PlakatDocument): PlakatDocument {
  if (!doc.template) return doc;
  const ids = new Set(doc.pages.flatMap((p) => p.elements.map((e) => e.id)));
  let changed = false;
  const slots = doc.template.slots.flatMap((slot) => {
    const targets = slot.targets.filter((t) => ids.has(t));
    if (targets.length === slot.targets.length) return [slot];
    changed = true;
    return targets.length ? [{ ...slot, targets }] : [];
  });
  return changed ? { ...doc, template: { ...doc.template, slots } } : doc;
}

/** Removes elements (any page) and cleans slot targets / empty slots. Pure. */
export function removeElements(doc: PlakatDocument, elementIds: Iterable<Id>): PlakatDocument {
  const drop = new Set(elementIds);
  const pages = doc.pages.map((p) =>
    p.elements.some((e) => drop.has(e.id)) ? { ...p, elements: p.elements.filter((e) => !drop.has(e.id)) } : p,
  );
  return pruneSlotTargets({ ...doc, pages });
}

/** Removes a page (a document keeps >= 1 page: removing the last one throws RangeError) and cleans slots. Pure. */
export function removePage(doc: PlakatDocument, pageId: Id): PlakatDocument {
  if (!doc.pages.some((p) => p.id === pageId)) throw new RangeError(`Unknown page "${pageId}"`);
  if (doc.pages.length === 1) throw new RangeError('A document must keep at least one page');
  return pruneSlotTargets({ ...doc, pages: doc.pages.filter((p) => p.id !== pageId) });
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Asset ids referenced by elements and page backgrounds. */
export function referencedAssetIds(doc: Pick<PlakatDocument, 'pages'>): Set<Id> {
  const ids = new Set<Id>();
  for (const page of doc.pages) {
    if (page.background.image) ids.add(page.background.image.assetId);
    for (const el of page.elements) if (el.type === 'image') ids.add(el.assetId);
  }
  return ids;
}

/** Drops registry entries no page references. */
export function pruneUnusedAssets(doc: PlakatDocument): PlakatDocument {
  const used = referencedAssetIds(doc);
  return { ...doc, assets: Object.fromEntries(Object.entries(doc.assets).filter(([id]) => used.has(id))) };
}

/** Canonicalizes derived data before persisting: fonts cache synced, dangling slot targets / empty slots pruned. */
export function normalizeDocument(doc: PlakatDocument): PlakatDocument {
  return syncFonts(pruneSlotTargets(doc));
}

/** Finds an element and its page. */
export function findElement(doc: Pick<PlakatDocument, 'pages'>, elementId: Id): { page: Page; element: PlakatElement; pageIndex: number; index: number } | null {
  for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex++) {
    const page = doc.pages[pageIndex]!;
    const index = page.elements.findIndex((e) => e.id === elementId);
    if (index !== -1) return { page, element: page.elements[index]!, pageIndex, index };
  }
  return null;
}
