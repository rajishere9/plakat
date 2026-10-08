import { cloneWithNewIds, findElement, normalizeDocument, pruneUnusedAssets, type FactoryOptions } from './factory.ts';
import { assertValidDocument } from './load.ts';
import type {
  Asset,
  Color,
  ColorSlot,
  Id,
  ImageSlot,
  PlakatDocument,
  PlakatElement,
  TemplateSlot,
  TextSlot,
} from './types.ts';
import { AssetSchema, canSlotTarget, COLOR_PATTERN, IdSchema, toValidationIssues } from './validation.ts';
import { createId, deepCopy, jsonEqual } from './ids.ts';

type Element = PlakatElement;

export class TemplateError extends Error {
  override name = 'TemplateError';
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export interface TextFill {
  text: string;
}
export interface ImageFill {
  /** Asset id to place. If `asset` is given it is added to the registry under this id. */
  assetId: Id;
  asset?: Asset;
}
export interface ColorFill {
  color: Color;
}
export type SlotFill = TextFill | ImageFill | ColorFill;
/** Keyed by slot id. */
export type SlotFills = Record<Id, SlotFill>;

export interface SlotInfo {
  slot: TemplateSlot;
  targets: { pageId: Id; pageIndex: number; element: Element }[];
  /** Current value read from the first target: text content, asset id, or color (null if unset). */
  value: string | null;
}

/** Slots with their resolved target elements and current values, in template order. */
export function listSlots(doc: PlakatDocument): SlotInfo[] {
  if (!doc.template) return [];
  return doc.template.slots.map((slot) => {
    const targets = slot.targets.flatMap((id) => {
      const hit = findElement(doc, id);
      return hit ? [{ pageId: hit.page.id, pageIndex: hit.pageIndex, element: hit.element }] : [];
    });
    return { slot, targets, value: readSlotValue(slot, targets[0]?.element) };
  });
}

function readSlotValue(slot: TemplateSlot, el: Element | undefined): string | null {
  if (!el) return null;
  switch (slot.kind) {
    case 'text':
      return el.type === 'text' ? el.content : null;
    case 'image':
      return el.type === 'image' ? el.assetId : null;
    case 'color':
      if (el.type === 'text') return slot.property === 'fill' ? el.fill : null;
      if (el.type === 'shape') return slot.property === 'fill' ? el.fill : el.stroke;
      return null;
  }
}

/** Element id -> slots that target it (editor: which elements are editable in fill mode). */
export function slotsByElement(doc: PlakatDocument): Map<Id, TemplateSlot[]> {
  const map = new Map<Id, TemplateSlot[]>();
  for (const slot of doc.template?.slots ?? []) {
    for (const t of slot.targets) map.set(t, [...(map.get(t) ?? []), slot]);
  }
  return map;
}

function checkFill(slot: TemplateSlot, fill: SlotFill, doc: PlakatDocument): void {
  const where = `slot "${slot.label || slot.id}"`;
  switch (slot.kind) {
    case 'text': {
      if (!('text' in fill) || typeof fill.text !== 'string') throw new TemplateError(`${where} expects a text fill`);
      if (slot.maxLength !== null && [...fill.text].length > slot.maxLength) {
        throw new TemplateError(`${where} allows at most ${slot.maxLength} characters`);
      }
      if (!slot.multiline && /[\r\n]/.test(fill.text)) throw new TemplateError(`${where} does not allow line breaks`);
      return;
    }
    case 'image': {
      if (!('assetId' in fill) || typeof fill.assetId !== 'string') throw new TemplateError(`${where} expects an image fill`);
      if (!IdSchema.safeParse(fill.assetId).success) throw new TemplateError(`${where}: invalid asset id "${fill.assetId}"`);
      if (fill.asset !== undefined) {
        const parsed = AssetSchema.safeParse(fill.asset);
        if (!parsed.success) {
          const first = toValidationIssues(parsed.error)[0];
          throw new TemplateError(`${where}: invalid asset (${first ? `${first.path}: ${first.message}` : 'unknown error'})`);
        }
      } else if (!Object.hasOwn(doc.assets, fill.assetId)) {
        throw new TemplateError(`${where}: asset "${fill.assetId}" is not in the registry and no asset was provided`);
      }
      return;
    }
    case 'color': {
      if (!('color' in fill) || typeof fill.color !== 'string') throw new TemplateError(`${where} expects a color fill`);
      if (!COLOR_PATTERN.test(fill.color)) throw new TemplateError(`${where}: invalid color "${fill.color}"`);
      return;
    }
  }
}

/**
 * Applies one fill to a document that has a template block (template or editor fill
 * mode). Pure. A slot only ever writes to its own targets: an image fill whose
 * `assetId` already names a DIFFERENT registry record is stored under a fresh `as_`
 * id instead of overwriting the record other elements/backgrounds use.
 */
export function applySlotFill(doc: PlakatDocument, slotId: Id, fill: SlotFill): PlakatDocument {
  const slot = doc.template?.slots.find((s) => s.id === slotId);
  if (!slot) throw new TemplateError(`Unknown slot "${slotId}"`);
  checkFill(slot, fill, doc);
  const targets = new Set(slot.targets);
  let assets = doc.assets;
  if (slot.kind === 'image' && 'assetId' in fill && fill.asset) {
    const asset = AssetSchema.parse(deepCopy(fill.asset));
    let assetId = fill.assetId;
    if (Object.hasOwn(assets, assetId) && !jsonEqual(assets[assetId], asset)) assetId = createId('as');
    assets = { ...assets, [assetId]: asset };
    fill = { assetId };
  }
  const pages = doc.pages.map((page) => ({
    ...page,
    elements: page.elements.map((el): Element => {
      if (!targets.has(el.id)) return el;
      if (slot.kind === 'text' && el.type === 'text' && 'text' in fill) return { ...el, content: fill.text };
      if (slot.kind === 'image' && el.type === 'image' && 'assetId' in fill) {
        return { ...el, assetId: fill.assetId, crop: null, objectFit: slot.fit };
      }
      if (slot.kind === 'color' && 'color' in fill) {
        if (slot.property === 'fill' && (el.type === 'shape' || el.type === 'text')) return { ...el, fill: fill.color };
        if (slot.property === 'stroke' && el.type === 'shape') return { ...el, stroke: fill.color };
      }
      return el;
    }),
  }));
  return { ...doc, assets, pages };
}

export interface InstantiateOptions extends FactoryOptions {
  title?: string;
  /** Throw if a `required` slot has no fill (default false: the template's placeholder stays). */
  enforceRequired?: boolean;
}

/**
 * "Use template": returns a NEW design document.
 *  1. fills are validated against their slots and applied (keys = template slot ids);
 *  2. every document/page/element/group id is regenerated (asset ids kept);
 *  3. kind -> "design", template -> null, meta.sourceTemplateId -> template id,
 *     createdAt/updatedAt -> now; unreferenced assets pruned; fonts synced.
 */
export function instantiateTemplate(
  template: PlakatDocument,
  fills: SlotFills = {},
  options: InstantiateOptions = {},
): PlakatDocument {
  if (template.kind !== 'template' || !template.template) {
    throw new TemplateError('instantiateTemplate() requires a document with kind "template"');
  }
  const known = new Set(template.template.slots.map((s) => s.id));
  for (const slotId of Object.keys(fills)) {
    if (!known.has(slotId)) throw new TemplateError(`Unknown slot "${slotId}"`);
  }
  if (options.enforceRequired) {
    const missing = template.template.slots.filter((s) => s.required && !Object.hasOwn(fills, s.id));
    if (missing.length) throw new TemplateError(`Missing required slots: ${missing.map((s) => s.label || s.id).join(', ')}`);
  }

  let filled = template;
  for (const [slotId, fill] of Object.entries(fills)) filled = applySlotFill(filled, slotId, fill);

  const { document } = cloneWithNewIds(filled);
  const ts = (options.now?.() ?? new Date()).toISOString();
  const design: PlakatDocument = {
    ...document,
    kind: 'design',
    template: null,
    meta: {
      ...document.meta,
      title: options.title ?? document.meta.title,
      createdAt: ts,
      updatedAt: ts,
      sourceTemplateId: template.id,
    },
  };
  const result = normalizeDocument(pruneUnusedAssets(design));
  assertValidDocument(result);
  return result;
}

// ---------------------------------------------------------------------------
// Save as template
// ---------------------------------------------------------------------------

type SpecCommon = { targets: Id[]; label?: string; description?: string; required?: boolean };
export type SlotSpec =
  | (SpecCommon & { kind: 'text'; maxLength?: number | null; multiline?: boolean })
  | (SpecCommon & { kind: 'image'; fit?: ImageSlot['fit'] })
  | (SpecCommon & { kind: 'color'; property?: ColorSlot['property']; palette?: Color[] });

export interface SaveAsTemplateOptions extends FactoryOptions {
  title?: string;
  category?: string | null;
}

function defaultLabel(el: Element): string {
  if (el.name) return el.name;
  if (el.type === 'text') {
    const firstLine = el.content.split('\n')[0] ?? '';
    return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine || 'Text';
  }
  return el.type === 'image' ? 'Image' : 'Color';
}

function inferSpec(doc: PlakatDocument, elementId: Id): SlotSpec {
  const hit = findElement(doc, elementId);
  if (!hit) throw new TemplateError(`Element "${elementId}" not found`);
  const el = hit.element;
  if (el.type === 'text') return { kind: 'text', targets: [el.id] };
  if (el.type === 'image') return { kind: 'image', targets: [el.id] };
  return { kind: 'color', targets: [el.id], property: el.fill === null && el.stroke !== null ? 'stroke' : 'fill' };
}

/** Builds a slot from an element id (inferred) or explicit spec; validates targets. */
function buildSlot(doc: PlakatDocument, input: Id | SlotSpec): TemplateSlot {
  const spec = typeof input === 'string' ? inferSpec(doc, input) : input;
  if (spec.targets.length === 0) throw new TemplateError('A slot needs at least one target');
  const first = findElement(doc, spec.targets[0]!);
  if (!first) throw new TemplateError(`Element "${spec.targets[0]}" not found`);
  const common = {
    id: createId('slot'),
    label: spec.label ?? defaultLabel(first.element),
    description: spec.description ?? '',
    required: spec.required ?? false,
    targets: [...new Set(spec.targets)],
  };
  let slot: TemplateSlot;
  switch (spec.kind) {
    case 'text':
      slot = { ...common, kind: 'text', maxLength: spec.maxLength ?? null, multiline: spec.multiline ?? true } satisfies TextSlot;
      break;
    case 'image':
      slot = { ...common, kind: 'image', fit: spec.fit ?? 'cover' } satisfies ImageSlot;
      break;
    case 'color':
      slot = { ...common, kind: 'color', property: spec.property ?? 'fill', palette: [...(spec.palette ?? [])] } satisfies ColorSlot;
      break;
  }
  checkSlotTargets(doc, slot);
  return slot;
}

/** Throws TemplateError unless every target exists and is compatible with the slot. */
function checkSlotTargets(doc: PlakatDocument, slot: TemplateSlot): void {
  if (slot.targets.length === 0) throw new TemplateError('A slot needs at least one target');
  for (const id of slot.targets) {
    const hit = findElement(doc, id);
    if (!hit) throw new TemplateError(`Element "${id}" not found`);
    if (!canSlotTarget(slot, hit.element)) {
      throw new TemplateError(`A ${slot.kind} slot cannot target a ${hit.element.type} element ("${id}")`);
    }
  }
}

function requireTemplate(doc: PlakatDocument): NonNullable<PlakatDocument['template']> {
  if (doc.kind !== 'template' || !doc.template) throw new TemplateError('Slots can only be edited on a template (see convertToTemplate())');
  return doc.template;
}

function withSlots(doc: PlakatDocument, slots: TemplateSlot[]): PlakatDocument {
  return { ...doc, template: { ...requireTemplate(doc), slots } };
}

// ---------------------------------------------------------------------------
// Id-preserving template authoring (template editor)
// ---------------------------------------------------------------------------

/**
 * Turns a document into a template IN PLACE: same document/page/element ids (so the
 * editor's selection, history and scene survive), kind -> "template", empty slot
 * table (or the existing one). For "Save a copy as template" use saveAsTemplate().
 */
export function convertToTemplate(doc: PlakatDocument, options: { category?: string | null } = {}): PlakatDocument {
  return {
    ...doc,
    kind: 'template',
    template: { category: options.category ?? doc.template?.category ?? null, slots: doc.template?.slots ?? [] },
  };
}

/** Adds a slot (bare element id = inferred spec, as in saveAsTemplate). Ids are preserved. */
export function addSlot(doc: PlakatDocument, spec: Id | SlotSpec): { document: PlakatDocument; slot: TemplateSlot } {
  const slot = buildSlot(doc, spec);
  return { document: withSlots(doc, [...requireTemplate(doc).slots, slot]), slot };
}

/** Patchable slot fields (kind, id and targets are fixed; use setSlotTargets for targets). */
export type SlotPatch =
  | Partial<Pick<TextSlot, 'label' | 'description' | 'required' | 'maxLength' | 'multiline'>>
  | Partial<Pick<ImageSlot, 'label' | 'description' | 'required' | 'fit'>>
  | Partial<Pick<ColorSlot, 'label' | 'description' | 'required' | 'property' | 'palette'>>;

/** Updates a slot's settings; re-checks target compatibility (e.g. color property). */
export function updateSlot(doc: PlakatDocument, slotId: Id, patch: SlotPatch): PlakatDocument {
  const slots = requireTemplate(doc).slots;
  const index = slots.findIndex((s) => s.id === slotId);
  if (index === -1) throw new TemplateError(`Unknown slot "${slotId}"`);
  const { id: _id, kind: _kind, targets: _targets, ...rest } = patch as Record<string, unknown>;
  const allowed = new Set(Object.keys(slots[index]!));
  for (const key of Object.keys(rest)) {
    if (!allowed.has(key)) throw new TemplateError(`Field "${key}" does not exist on a ${slots[index]!.kind} slot`);
  }
  const next = { ...slots[index]!, ...deepCopy(rest) } as TemplateSlot;
  if (next.kind === 'color' && next.palette.some((c) => !COLOR_PATTERN.test(c))) throw new TemplateError('Invalid palette color');
  checkSlotTargets(doc, next);
  return withSlots(doc, slots.map((s, i) => (i === index ? next : s)));
}

/** Replaces a slot's targets (>= 1, compatible, de-duplicated). */
export function setSlotTargets(doc: PlakatDocument, slotId: Id, targets: readonly Id[]): PlakatDocument {
  const slots = requireTemplate(doc).slots;
  const index = slots.findIndex((s) => s.id === slotId);
  if (index === -1) throw new TemplateError(`Unknown slot "${slotId}"`);
  const next = { ...slots[index]!, targets: [...new Set(targets)] } as TemplateSlot;
  checkSlotTargets(doc, next);
  return withSlots(doc, slots.map((s, i) => (i === index ? next : s)));
}

/** Removes a slot (its target elements stay as fixed design). */
export function removeSlot(doc: PlakatDocument, slotId: Id): PlakatDocument {
  const slots = requireTemplate(doc).slots;
  if (!slots.some((s) => s.id === slotId)) throw new TemplateError(`Unknown slot "${slotId}"`);
  return withSlots(doc, slots.filter((s) => s.id !== slotId));
}

/** Moves a slot to `index` in the fill form order. */
export function moveSlot(doc: PlakatDocument, slotId: Id, index: number): PlakatDocument {
  const slots = [...requireTemplate(doc).slots];
  const from = slots.findIndex((s) => s.id === slotId);
  if (from === -1) throw new TemplateError(`Unknown slot "${slotId}"`);
  const [slot] = slots.splice(from, 1);
  slots.splice(Math.min(Math.max(index, 0), slots.length), 0, slot!);
  return withSlots(doc, slots);
}

/**
 * "Save a copy as template": returns a NEW template document built from any document.
 * Regenerates EVERY id and REPLACES the slot table; for editing slots of an open
 * template use the id-preserving helpers above (addSlot, updateSlot, ...).
 * `slots` items are element ids (slot kind inferred: text->text, image->image,
 * shape->color) or explicit SlotSpecs. All ids are regenerated and slot targets
 * remapped. Throws TemplateError / DocumentValidationError on invalid specs.
 */
export function saveAsTemplate(
  design: PlakatDocument,
  slots: ReadonlyArray<Id | SlotSpec>,
  options: SaveAsTemplateOptions = {},
): PlakatDocument {
  const slotDefs: TemplateSlot[] = slots.map((s) => buildSlot(design, s));

  const source: PlakatDocument = {
    ...design,
    kind: 'template',
    template: { category: options.category ?? design.template?.category ?? null, slots: slotDefs },
  };
  const { document } = cloneWithNewIds(source);
  const ts = (options.now?.() ?? new Date()).toISOString();
  const template: PlakatDocument = normalizeDocument({
    ...document,
    meta: {
      ...document.meta,
      title: options.title ?? document.meta.title,
      createdAt: ts,
      updatedAt: ts,
      sourceTemplateId: null,
    },
  });
  assertValidDocument(template);
  return template;
}
