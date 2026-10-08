/** Page actions and document resize. */
import {
  clonePageWithNewIds,
  createPage,
  deepCopy,
  presetToPageSize,
  removePage,
  type PageSize,
  type PlakatDocument,
  type PlakatElement,
} from '@plakat/schema';
import { ensureDraftAsset, type ActionContext } from './internal.ts';
import type { CommitOptions, EditorActions, ResizeDocumentOptions } from './types.ts';

type PageKeys = 'addPage' | 'duplicatePage' | 'deletePage' | 'movePage' | 'renamePage' | 'setPageBackground' | 'resizeDocument';

/** Uniformly scales an element about the page origin by k, then offsets it. Pure. */
export function scaleElement(el: PlakatElement, k: number, ox: number, oy: number): PlakatElement {
  const base = { ...el, x: el.x * k + ox, y: el.y * k + oy, width: el.width * k, height: el.height * k };
  switch (base.type) {
    case 'text':
      return { ...base, fontSize: Math.min(5_000, Math.max(0.01, base.fontSize * k)) };
    case 'shape':
      return {
        ...base,
        strokeWidth: Math.min(1_000, base.strokeWidth * k),
        cornerRadius: Math.min(100_000, base.cornerRadius * k),
        dash: base.dash.map((v) => Math.min(10_000, v * k)),
      };
    case 'image':
      return {
        ...base,
        cornerRadius: Math.min(100_000, base.cornerRadius * k),
        filters: { ...base.filters, blur: Math.min(100, base.filters.blur * k) },
      };
  }
}

/**
 * Resizes a document. content 'scale' (default): k = min(newW/oldW, newH/oldH), all
 * elements scaled about the origin by k and centered in the new page (letterboxed
 * along the other axis). 'none': geometry untouched. Pure.
 */
export function resizeDocumentPure(doc: PlakatDocument, size: PageSize, options: ResizeDocumentOptions = {}): PlakatDocument {
  const old = doc.size;
  const next: PlakatDocument = { ...doc, size: deepCopy(size) };
  if ((options.content ?? 'scale') === 'none' || (old.width === size.width && old.height === size.height)) return next;
  const k = Math.min(size.width / old.width, size.height / old.height);
  const ox = (size.width - old.width * k) / 2;
  const oy = (size.height - old.height * k) / 2;
  return { ...next, pages: doc.pages.map((p) => ({ ...p, elements: p.elements.map((e) => scaleElement(e, k, ox, oy)) })) };
}

export function createPageActions(ctx: ActionContext): Pick<EditorActions, PageKeys> {
  const { get, commit } = ctx;
  const resolvePage = (pageId?: string) => {
    const s = get();
    return s.document.pages.find((p) => p.id === (pageId ?? s.activePageId));
  };

  return {
    addPage(options = {}) {
      const s = get();
      const activeIndex = s.document.pages.findIndex((p) => p.id === s.activePageId);
      const at = Math.min(Math.max(options.index ?? activeIndex + 1, 0), s.document.pages.length);
      const page = createPage({
        background: { color: options.background?.color === undefined ? '#ffffff' : options.background.color, image: options.background?.image ?? null },
      });
      commit('Add page', (d) => {
        d.pages.splice(at, 0, page);
      }, { activePageId: page.id, select: [] });
      return page.id;
    },

    duplicatePage(pageId) {
      const src = resolvePage(pageId);
      if (!src) return null;
      const copy = clonePageWithNewIds(src);
      commit('Duplicate page', (d) => {
        const i = d.pages.findIndex((p) => p.id === src.id);
        d.pages.splice(i + 1, 0, copy);
      }, { activePageId: copy.id, select: [] });
      return copy.id;
    },

    deletePage(pageId) {
      const page = resolvePage(pageId);
      const doc = get().document;
      if (!page || doc.pages.length <= 1) return false;
      commit('Delete page', (_d, base) => removePage(base, page.id), { select: [] });
      return true;
    },

    movePage(pageId, toIndex) {
      commit('Move page', (d) => {
        const from = d.pages.findIndex((p) => p.id === pageId);
        if (from === -1) return;
        const to = Math.min(Math.max(Math.round(toIndex), 0), d.pages.length - 1);
        if (from === to) return;
        const [p] = d.pages.splice(from, 1);
        d.pages.splice(to, 0, p!);
      });
    },

    renamePage(pageId, name) {
      commit('Rename page', (d) => {
        const p = d.pages.find((x) => x.id === pageId);
        if (p) p.name = name.slice(0, 200);
      }, { coalesceKey: `rename-page:${pageId}` });
    },

    setPageBackground(pageId, background) {
      const page = resolvePage(pageId);
      if (!page) return;
      const opts: CommitOptions = {};
      if (background.color !== undefined) opts.coalesceKey = `bg-color:${page.id}`;
      commit('Background', (d) => {
        const p = d.pages.find((x) => x.id === page.id)!;
        if (background.color !== undefined) {
          const c = background.color;
          if (c === null || /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c)) p.background.color = c === null ? null : c.toLowerCase();
        }
        if (background.image !== undefined) {
          p.background.image = background.image === null ? null : { assetId: ensureDraftAsset(d, background.image).id };
        }
      }, opts);
    },

    resizeDocument(size, options = {}) {
      const target: PageSize = typeof size === 'string' ? presetToPageSize(size) : size;
      if (!(target.width >= 1 && target.height >= 1 && target.width <= 20_000 && target.height <= 20_000)) {
        throw new RangeError('Page size must be within 1..20000 px');
      }
      commit('Resize design', (_d, base) => resizeDocumentPure(base, target, options));
    },
  };
}
