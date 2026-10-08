/**
 * Clipboard payload (internal clipboard + optional system-clipboard interop so content
 * can be pasted between tabs / documents). Assets travel with the elements and are
 * merged on paste through importElements() (schema D-11).
 */
import {
  AssetSchema,
  ElementSchema,
  findReservedKey,
  referencedAssetIds,
  deepCopy,
  type Asset,
  type Id,
  type PlakatDocument,
  type PlakatElement,
} from '@plakat/schema';

export const CLIPBOARD_FORMAT = 'plakat.clipboard';
/** Custom MIME for DataTransfer / ClipboardItem (web custom formats need the "web " prefix with the async API). */
export const CLIPBOARD_MIME = 'application/x-plakat-clipboard+json';

export interface ClipboardData {
  /** Elements in z-order (bottom first), deep copies. */
  elements: PlakatElement[];
  /** Asset records referenced by the elements. */
  assets: Record<Id, Asset>;
  sourceDocumentId: Id | null;
  sourcePageId: Id | null;
}

/** Copies elements (in page z-order) plus the assets they reference. */
export function buildClipboardData(doc: PlakatDocument, pageId: Id, ids: Iterable<Id>): ClipboardData | null {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return null;
  const want = new Set(ids);
  const elements = page.elements.filter((e) => want.has(e.id)).map((e) => deepCopy(e));
  if (elements.length === 0) return null;
  const assets: Record<Id, Asset> = {};
  for (const id of referencedAssetIds({ pages: [{ ...page, elements, background: { color: null, image: null } }] })) {
    const a = Object.hasOwn(doc.assets, id) ? doc.assets[id] : undefined;
    if (a) assets[id] = deepCopy(a);
  }
  return { elements, assets, sourceDocumentId: doc.id, sourcePageId: pageId };
}

export function serializeClipboard(data: ClipboardData): string {
  return JSON.stringify({ format: CLIPBOARD_FORMAT, version: 1, ...data });
}

/** Parses + validates a serialized clipboard payload; null if it is not one or is invalid. */
export function parseClipboard(text: string): ClipboardData | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || (json as Record<string, unknown>)['format'] !== CLIPBOARD_FORMAT) return null;
  if (findReservedKey(json)) return null;
  const obj = json as Record<string, unknown>;
  const rawEls = Array.isArray(obj['elements']) ? obj['elements'] : [];
  const elements: PlakatElement[] = [];
  for (const raw of rawEls) {
    const r = ElementSchema.safeParse(raw);
    if (!r.success) return null;
    elements.push(r.data as PlakatElement);
  }
  const assets: Record<Id, Asset> = {};
  const rawAssets = obj['assets'] && typeof obj['assets'] === 'object' ? (obj['assets'] as Record<string, unknown>) : {};
  for (const [id, raw] of Object.entries(rawAssets)) {
    const r = AssetSchema.safeParse(raw);
    if (!r.success) return null;
    assets[id] = r.data as Asset;
  }
  for (const el of elements) if (el.type === 'image' && !Object.hasOwn(assets, el.assetId)) return null;
  if (elements.length === 0) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return { elements, assets, sourceDocumentId: str(obj['sourceDocumentId']), sourcePageId: str(obj['sourcePageId']) };
}
