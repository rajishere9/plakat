/** Element actions: add, update, transform, delete, duplicate, fonts, images, clipboard. */
import {
  bakeTransform,
  centerOnPage,
  cloneElementsWithNewIds,
  createImageElement,
  createShapeElement,
  createTextElement,
  DEFAULT_FILTERS,
  fitCropToImage,
  FONT_FAMILY_PATTERN,
  importElements,
  jsonEqual,
  matchFontWeight,
  normalizeRotation,
  removeElements,
  rotateAroundCenter,
  type Id,
  type PlakatElement,
  type TextElement,
} from '@plakat/schema';
import { buildClipboardData, type ClipboardData } from '../lib/clipboard.ts';
import { remapCrop } from '../lib/crop.ts';
import { sanitizeElementPatch, sanitizeFilters, type ElementPatch } from '../lib/element-patch.ts';
import { adaptVariantToFamily, availableWeights, hasItalic, isBold, toggledBoldWeight } from '../lib/fonts.ts';
import {
  elementIndex,
  ensureDraftAsset,
  expandGroups,
  findDraftElement,
  findDraftPage,
  targetIds,
  type ActionContext,
} from './internal.ts';
import type { AddTextPreset, CommitOptions, EditorActions } from './types.ts';

export const DUPLICATE_OFFSET = 16;

const TEXT_PRESETS: Record<AddTextPreset, { scale: number; fontWeight: TextElement['fontWeight']; content: string }> = {
  heading: { scale: 0.08, fontWeight: 700, content: 'Add a heading' },
  subheading: { scale: 0.05, fontWeight: 600, content: 'Add a subheading' },
  body: { scale: 0.03, fontWeight: 400, content: 'Add a little bit of body text' },
};

type ElementActionKeys =
  | 'addText'
  | 'addShape'
  | 'addImage'
  | 'insertElements'
  | 'addAsset'
  | 'updateElement'
  | 'updateElements'
  | 'commitTransforms'
  | 'moveElements'
  | 'setRotation'
  | 'deleteElements'
  | 'duplicateElements'
  | 'rename'
  | 'setLocked'
  | 'toggleLock'
  | 'setHidden'
  | 'toggleHidden'
  | 'setFontFamily'
  | 'toggleBold'
  | 'toggleItalic'
  | 'setTextContent'
  | 'setCrop'
  | 'replaceImage'
  | 'setFilters'
  | 'resetFilters'
  | 'flip'
  | 'copy'
  | 'cut'
  | 'paste';

export function createElementActions(ctx: ActionContext): Pick<EditorActions, ElementActionKeys> {
  const { get, set, commit } = ctx;

  const pageIdFor = (pageId?: Id) => {
    const s = get();
    return pageId && s.document.pages.some((p) => p.id === pageId) ? pageId : s.activePageId;
  };

  /** Inserts a freshly created element (same document, so no asset merge needed). */
  const insertNew = (label: string, make: (draft: Parameters<Parameters<typeof commit>[1]>[0]) => PlakatElement, options: { pageId?: Id; select?: boolean } = {}): Id => {
    const pageId = pageIdFor(options.pageId);
    let id = '';
    // The recipe fills in `select` (commit reads options after running the recipe), so the
    // history entry's selectionAfter is the new element and redo re-selects it.
    const opts: CommitOptions = { activePageId: pageId };
    commit(label, (d) => {
      const el = make(d);
      id = el.id;
      findDraftPage(d, pageId)!.elements.push(el);
      if (options.select !== false) opts.select = [el.id];
    }, opts);
    return id;
  };

  const place = <E extends PlakatElement>(el: E, keepPosition: boolean | undefined): E =>
    keepPosition ? el : centerOnPage(el, get().document.size);

  const updateMany = (
    ids: readonly Id[],
    patchFor: (el: PlakatElement) => ElementPatch | null,
    label: string,
    options: Parameters<EditorActions['updateElements']>[2] = {},
  ) => {
    const { label: _l, ...commitOpts } = options;
    commit(
      label,
      (d) => {
        for (const id of ids) {
          const el = findDraftElement(d, id);
          if (!el) continue;
          const raw = patchFor(el as PlakatElement);
          if (!raw) continue;
          const { patch } = sanitizeElementPatch(el as PlakatElement, raw as Record<string, unknown>);
          for (const [k, v] of Object.entries(patch)) {
            const cur = (el as Record<string, unknown>)[k];
            if (v !== null && typeof v === 'object' ? !jsonEqual(cur, v) : cur !== v) (el as Record<string, unknown>)[k] = v;
          }
        }
      },
      commitOpts,
    );
  };

  const textTargets = (ids?: Id[]): TextElement[] => {
    const idx = elementIndex(get().document);
    return targetIds(ctx, ids)
      .map((id) => idx.get(id)?.element)
      .filter((e): e is TextElement => e?.type === 'text');
  };

  const actions: Pick<EditorActions, ElementActionKeys> = {
    addText(partial = {}, options = {}) {
      const { preset, ...rest } = partial;
      const size = get().document.size;
      const unit = Math.min(size.width, size.height);
      const p = preset ? TEXT_PRESETS[preset] : undefined;
      const fontSize = rest.fontSize ?? (p ? Math.max(8, Math.round(unit * p.scale)) : undefined);
      const fields: Partial<Omit<TextElement, 'type'>> = { ...(p ? { content: p.content, fontWeight: p.fontWeight } : {}), ...rest };
      if (fontSize !== undefined) fields.fontSize = fontSize;
      return insertNew('Add text', () => place(createTextElement(fields, { page: size }), options.keepPosition), options);
    },

    addShape(shape, partial = {}, options = {}) {
      const size = get().document.size;
      return insertNew('Add shape', () => place(createShapeElement(shape, partial, { page: size }), options.keepPosition), options);
    },

    addImage(input, partial = {}, options = {}) {
      const size = get().document.size;
      return insertNew(
        'Add image',
        (d) => {
          const { id, asset } = ensureDraftAsset(d, input);
          return place(createImageElement(id, asset, partial, { page: size }), options.keepPosition);
        },
        options,
      );
    },

    insertElements(elements, assets = {}, options = {}) {
      if (elements.length === 0) return [];
      const pageId = pageIdFor(options.pageId);
      const off = options.offset ?? { x: 0, y: 0 };
      const shifted = elements.map((e) => ({ ...e, x: e.x + off.x, y: e.y + off.y }));
      let ids: Id[] = [];
      const opts: CommitOptions = { activePageId: pageId };
      commit(
        'Insert',
        (_d, base) => {
          const r = importElements(base, pageId, { elements: shifted, assets });
          ids = r.elementIds;
          if (options.select !== false) opts.select = ids;
          return r.document;
        },
        opts,
      );
      return ids;
    },

    addAsset(input) {
      let id = '';
      commit('Add asset', (d) => {
        id = ensureDraftAsset(d, input).id;
      });
      return id;
    },

    updateElement(id, patch, options = {}) {
      updateMany([id], () => patch, options.label ?? 'Edit', options);
    },

    updateElements(ids, patch, options = {}) {
      updateMany(ids, typeof patch === 'function' ? patch : () => patch, options.label ?? 'Edit', options);
    },

    commitTransforms(transforms, options = {}) {
      const ids = Object.keys(transforms);
      if (ids.length === 0) return;
      const idx = elementIndex(get().document);
      const anyResize = ids.some((id) => {
        const t = transforms[id]!;
        return Math.abs(t.scaleX - 1) > 1e-9 || Math.abs(t.scaleY - 1) > 1e-9;
      });
      const anyRotate = ids.some((id) => {
        const el = idx.get(id)?.element;
        return !!el && Math.abs(normalizeRotation(transforms[id]!.rotation) - normalizeRotation(el.rotation)) > 1e-9;
      });
      const label = options.label ?? (anyResize ? 'Resize' : anyRotate ? 'Rotate' : 'Move');
      commit(
        label,
        (d) => {
          for (const id of ids) {
            const base = idx.get(id)?.element;
            const el = findDraftElement(d, id);
            if (!base || !el || base.locked) continue;
            let baked: PlakatElement;
            try {
              baked = bakeTransform(base, transforms[id]!);
            } catch (e) {
              console.warn(`[plakat] transform of ${id} not representable:`, e);
              continue;
            }
            baked = { ...baked, rotation: normalizeRotation(baked.rotation) };
            const { patch } = sanitizeElementPatch(base, baked as unknown as Record<string, unknown>);
            for (const [k, v] of Object.entries(patch)) {
              if (typeof v !== 'object' || v === null) (el as Record<string, unknown>)[k] = v;
            }
          }
        },
        { touched: ids },
      );
    },

    moveElements(ids, dx, dy, options = {}) {
      // A zero move still notifies (touched) so the canvas resets nodes after a drag that snapped back.
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const { label, ...rest } = options;
      commit(
        label ?? 'Move',
        (d) => {
          for (const id of ids) {
            const el = findDraftElement(d, id);
            if (!el || el.locked) continue;
            el.x += dx;
            el.y += dy;
          }
        },
        { touched: [...ids], ...rest },
      );
    },

    setRotation(ids, rotation, options = {}) {
      if (!Number.isFinite(rotation)) return;
      const r = normalizeRotation(rotation);
      commit(
        'Rotate',
        (d) => {
          for (const id of ids) {
            const el = findDraftElement(d, id);
            if (!el || el.locked) continue;
            Object.assign(el, rotateAroundCenter(el, r));
          }
        },
        { coalesceKey: `rotate:${ids.join(',')}`, ...options },
      );
    },

    deleteElements(ids, options = {}) {
      const idx = elementIndex(get().document);
      const drop = targetIds(ctx, ids).filter((id) => {
        const el = idx.get(id)?.element;
        return !!el && (options.force || !el.locked);
      });
      if (drop.length === 0) return;
      commit(drop.length > 1 ? 'Delete elements' : 'Delete', (_d, base) => removeElements(base, drop));
    },

    duplicateElements(ids) {
      const s = get();
      const want = new Set(expandGroups(s.document, targetIds(ctx, ids)));
      if (want.size === 0) return [];
      const newIds: Id[] = [];
      commit(
        'Duplicate',
        (d, base) => {
          for (const page of base.pages) {
            const originals = page.elements.filter((e) => want.has(e.id));
            if (originals.length === 0) continue;
            const clones = cloneElementsWithNewIds(originals).map((c) => ({ ...c, x: c.x + DUPLICATE_OFFSET, y: c.y + DUPLICATE_OFFSET, locked: false }));
            const top = Math.max(...originals.map((o) => page.elements.indexOf(o)));
            findDraftPage(d, page.id)!.elements.splice(top + 1, 0, ...clones);
            newIds.push(...clones.map((c) => c.id));
          }
        },
        { select: newIds },
      );
      return newIds;
    },

    rename(id, name) {
      updateMany([id], () => ({ name }), 'Rename', { coalesceKey: `rename:${id}` });
    },

    setLocked(ids, locked) {
      updateMany(ids, () => ({ locked }), locked ? 'Lock' : 'Unlock');
    },
    toggleLock(ids) {
      const idx = elementIndex(get().document);
      const list = targetIds(ctx, ids).filter((id) => idx.has(id));
      if (!list.length) return;
      const lock = list.some((id) => !idx.get(id)!.element.locked);
      actions.setLocked(list, lock);
    },
    setHidden(ids, hidden) {
      updateMany(ids, () => ({ hidden }), hidden ? 'Hide' : 'Show');
    },
    toggleHidden(ids) {
      const idx = elementIndex(get().document);
      const list = targetIds(ctx, ids).filter((id) => idx.has(id));
      if (!list.length) return;
      const hide = list.some((id) => !idx.get(id)!.element.hidden);
      actions.setHidden(list, hide);
    },

    // --- text & fonts -----------------------------------------------------------
    setFontFamily(ids, family) {
      if (!FONT_FAMILY_PATTERN.test(family)) return;
      updateMany(
        ids,
        (el) => (el.type === 'text' ? { fontFamily: family, ...adaptVariantToFamily(family, el.fontWeight, el.fontStyle) } : null),
        'Change font',
      );
    },
    toggleBold(ids) {
      const els = textTargets(ids);
      const first = els[0];
      if (!first) return;
      const on = !isBold(first.fontWeight);
      updateMany(
        els.map((e) => e.id),
        (el) => (el.type === 'text' ? { fontWeight: toggledBoldWeight(el.fontFamily, on ? 400 : 700, el.fontStyle) } : null),
        on ? 'Bold' : 'Remove bold',
      );
    },
    toggleItalic(ids) {
      const els = textTargets(ids);
      const first = els[0];
      if (!first) return;
      const on = first.fontStyle !== 'italic';
      updateMany(
        els.map((e) => e.id),
        (el) => {
          if (el.type !== 'text') return null;
          const style = on && hasItalic(el.fontFamily) ? 'italic' : 'normal';
          return { fontStyle: style, fontWeight: matchFontWeight(el.fontWeight, availableWeights(el.fontFamily, style)) };
        },
        on ? 'Italic' : 'Remove italic',
      );
    },
    setTextContent(id, content) {
      updateMany([id], (el) => (el.type === 'text' ? { content } : null), 'Edit text', { coalesceKey: `text:${id}`, coalesceWindowMs: Infinity });
    },

    // --- images -------------------------------------------------------------------
    setCrop(id, crop, options = {}) {
      const s = get();
      const el = elementIndex(s.document).get(id)?.element;
      if (!el || el.type !== 'image') return;
      const asset = Object.hasOwn(s.document.assets, el.assetId) ? s.document.assets[el.assetId] : undefined;
      if (!asset) return;
      const fitted = crop ? fitCropToImage(crop, asset.width, asset.height) : null;
      updateMany([id], () => ({ ...(options.box ?? {}), crop: fitted }), 'Crop');
    },
    replaceImage(id, input) {
      const s = get();
      const base = elementIndex(s.document).get(id)?.element;
      if (!base || base.type !== 'image') return;
      const oldAsset = Object.hasOwn(s.document.assets, base.assetId) ? s.document.assets[base.assetId] : undefined;
      commit('Replace image', (d) => {
        const { id: assetId, asset } = ensureDraftAsset(d, input);
        const el = findDraftElement(d, id);
        if (!el || el.type !== 'image') return;
        el.assetId = assetId;
        el.crop = oldAsset ? remapCrop(base.crop, oldAsset, asset, base) : null;
      });
    },
    setFilters(ids, filters, options = {}) {
      const clean = sanitizeFilters(filters as Record<string, unknown>);
      updateMany(ids, (el) => (el.type === 'image' ? { filters: clean } : null), 'Adjust image', {
        coalesceKey: `filters:${[...ids].sort().join(',')}`,
        ...options,
      });
    },
    resetFilters(ids) {
      updateMany(targetIds(ctx, ids), (el) => (el.type === 'image' ? { filters: { ...DEFAULT_FILTERS } } : null), 'Reset adjustments');
    },
    flip(ids, axis) {
      updateMany(ids, (el) => (el.type === 'image' ? (axis === 'x' ? { flipX: !el.flipX } : { flipY: !el.flipY }) : null), axis === 'x' ? 'Flip horizontal' : 'Flip vertical');
    },

    // --- clipboard ---------------------------------------------------------------------
    copy(ids) {
      const s = get();
      const list = expandGroups(s.document, targetIds(ctx, ids));
      if (!list.length) return null;
      const page = s.document.pages.find((p) => p.elements.some((e) => e.id === list[0])) ?? s.document.pages[0]!;
      const data = buildClipboardData(s.document, page.id, list);
      if (data) set({ clipboard: { ...data, pasteCount: 0 } });
      return data;
    },
    cut(ids) {
      const data = actions.copy(ids);
      if (!data) return null;
      commit('Cut', (_d, base) => removeElements(base, data.elements.map((e) => e.id)));
      return data;
    },
    paste(data, options = {}) {
      const s = get();
      const internal = !data;
      const src: (ClipboardData & { pasteCount?: number }) | null = data ?? s.clipboard;
      if (!src || src.elements.length === 0) return [];
      const pageId = pageIdFor(options.pageId);
      const page = s.document.pages.find((p) => p.id === pageId)!;
      const originalsHere = src.sourceDocumentId === s.document.id && src.elements.some((e) => page.elements.some((pe) => pe.id === e.id));
      const n = internal ? (s.clipboard?.pasteCount ?? 0) + 1 : 1;
      const off = originalsHere ? DUPLICATE_OFFSET * n : 0;
      const ids = actions.insertElements(src.elements, src.assets, { pageId, offset: { x: off, y: off } });
      if (internal && s.clipboard && originalsHere) set({ clipboard: { ...s.clipboard, pasteCount: n } });
      return ids;
    },
  };
  return actions;
}
