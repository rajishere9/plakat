/** Helpers shared by the action modules (not part of the public API). */
import type { Draft } from 'immer';
import {
  AssetSchema,
  createImageAsset,
  toValidationIssues,
  type Asset,
  type Id,
  type Page,
  type PlakatDocument,
  type PlakatElement,
} from '@plakat/schema';
import type { AssetInput, EditorActions, EditorState } from './types.ts';

export interface ActionContext {
  get(): EditorState;
  set(partial: Partial<EditorState>): void;
  commit: EditorActions['commit'];
  now(): number;
}

/** `ids` or the current selection. */
export function targetIds(ctx: ActionContext, ids?: readonly Id[]): Id[] {
  return [...(ids ?? ctx.get().selectedIds)];
}

export function getActivePage(state: Pick<EditorState, 'document' | 'activePageId'>): Page {
  return state.document.pages.find((p) => p.id === state.activePageId) ?? state.document.pages[0]!;
}

/** Element lookup map over all pages. */
export function elementIndex(doc: Pick<PlakatDocument, 'pages'>): Map<Id, { element: PlakatElement; page: Page; index: number }> {
  const map = new Map<Id, { element: PlakatElement; page: Page; index: number }>();
  for (const page of doc.pages) page.elements.forEach((element, index) => map.set(element.id, { element, page, index }));
  return map;
}

/** Draft element by id (any page), or undefined. */
export function findDraftElement(draft: Draft<PlakatDocument>, id: Id): Draft<PlakatElement> | undefined {
  for (const page of draft.pages) {
    const el = page.elements.find((e) => e.id === id);
    if (el) return el;
  }
  return undefined;
}

export function findDraftPage(draft: Draft<PlakatDocument>, pageId: Id): Draft<Page> | undefined {
  return draft.pages.find((p) => p.id === pageId);
}

export class InvalidAssetError extends Error {
  override name = 'InvalidAssetError';
}

/** Validates a new asset record (throws InvalidAssetError). */
export function validateAsset(asset: Asset): Asset {
  const parsed = AssetSchema.safeParse(asset);
  if (!parsed.success) {
    const first = toValidationIssues(parsed.error)[0];
    throw new InvalidAssetError(`Invalid image asset${first ? ` (${first.path}: ${first.message})` : ''}`);
  }
  return parsed.data as Asset;
}

/**
 * Resolves an AssetInput against a document registry: an existing id is returned as
 * is; a new record reuses an existing entry with the same src, else gets a fresh id.
 * Returns the id and (when new) the record to add.
 */
export function resolveAssetInput(assets: Readonly<Record<Id, Asset>>, input: AssetInput): { id: Id; asset: Asset | null; existing: Asset | null } {
  if ('assetId' in input) {
    const existing = Object.hasOwn(assets, input.assetId) ? assets[input.assetId]! : null;
    if (!existing) throw new InvalidAssetError(`Unknown asset "${input.assetId}"`);
    return { id: input.assetId, asset: null, existing };
  }
  const same = Object.entries(assets).find(([, a]) => a.src === input.src && a.width === input.width && a.height === input.height);
  if (same) return { id: same[0], asset: null, existing: same[1] };
  const created = createImageAsset({
    src: input.src,
    width: input.width,
    height: input.height,
    mimeType: input.mimeType,
    name: input.name ?? '',
    source: input.source ?? null,
  });
  return { id: created.id, asset: validateAsset(created.asset), existing: null };
}

/** Adds the asset (if new) to the draft registry and returns its id + record. */
export function ensureDraftAsset(draft: Draft<PlakatDocument>, input: AssetInput): { id: Id; asset: Asset } {
  const r = resolveAssetInput(draft.assets as Record<Id, Asset>, input);
  if (r.asset) {
    draft.assets[r.id] = r.asset;
    return { id: r.id, asset: r.asset };
  }
  return { id: r.id, asset: r.existing! };
}

/** Expands ids with every element sharing their groupId on the same page. */
export function expandGroups(doc: Pick<PlakatDocument, 'pages'>, ids: readonly Id[]): Id[] {
  const out: Id[] = [];
  const seen = new Set<Id>();
  const idx = elementIndex(doc);
  for (const id of ids) {
    const hit = idx.get(id);
    if (!hit) continue;
    const members = hit.element.groupId ? hit.page.elements.filter((e) => e.groupId === hit.element.groupId).map((e) => e.id) : [id];
    for (const m of [id, ...members]) {
      if (!seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
  }
  return out;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
