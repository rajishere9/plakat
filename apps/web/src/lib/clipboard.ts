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
  fitCropToImage,
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

/** Payload format version (bump together with incompatible element/asset changes). */
export const CLIPBOARD_VERSION = 1;

export function serializeClipboard(data: ClipboardData): string {
  return JSON.stringify({ format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, ...data });
}

/** Identity of a payload (same copy = same key), used to cascade repeated pastes. */
export function clipboardKey(data: Pick<ClipboardData, 'elements' | 'sourceDocumentId'>): string {
  return `${data.sourceDocumentId ?? ''}|${data.elements.map((e) => e.id).join(',')}`;
}

/**
 * Human-readable text/plain for a copy: the text of copied text elements (one per line).
 * Never the JSON payload, which would otherwise land in text fields and other apps.
 */
export function clipboardPlainText(data: Pick<ClipboardData, 'elements'>): string {
  return data.elements
    .flatMap((e) => (e.type === 'text' && e.content.trim() ? [e.content] : []))
    .join('\n');
}

const HTML_ATTR = 'data-plakat-clipboard';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * text/html flavor: the visible text plus the payload in a data attribute, a fallback
 * for browsers that drop the custom MIME type between tabs.
 */
export function clipboardHtml(data: ClipboardData): string {
  const text = clipboardPlainText(data);
  return `<meta charset="utf-8"><div ${HTML_ATTR}="${escapeHtml(serializeClipboard(data))}">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

/** Extracts a payload from clipboardHtml() output (null for any other HTML). */
export function parseClipboardHtml(html: string): ClipboardData | null {
  if (!html.includes(HTML_ATTR)) return null;
  let raw: string | null = null;
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    raw = doc.querySelector(`[${HTML_ATTR}]`)?.getAttribute(HTML_ATTR) ?? null;
  } else {
    const m = new RegExp(`${HTML_ATTR}="([^"]*)"`).exec(html);
    raw = m ? m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
  }
  return raw ? parseClipboard(raw) : null;
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
  // Unknown (newer/older) payload versions are refused rather than guessed at.
  if (obj['version'] !== CLIPBOARD_VERSION) return null;
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
  // Document-level constraints the per-element schema cannot check: a crop must lie inside
  // its asset's declared size. Repair (never distort) instead of producing an invalid document.
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    if (el.type !== 'image' || !el.crop) continue;
    const a = assets[el.assetId]!;
    const c = el.crop;
    if (c.x < 0 || c.y < 0 || c.x + c.width > a.width + 1e-6 || c.y + c.height > a.height + 1e-6) {
      elements[i] = { ...el, crop: fitCropToImage(c, a.width, a.height, el.width / el.height) };
    }
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return { elements, assets, sourceDocumentId: str(obj['sourceDocumentId']), sourcePageId: str(obj['sourcePageId']) };
}
