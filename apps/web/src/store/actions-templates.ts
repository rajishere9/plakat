/** Template slot authoring / fill and brand-kit actions. */
import {
  addSlot as addSlotPure,
  applyBrandKit as applyBrandKitPure,
  applySlotFill,
  convertToTemplate as convertToTemplatePure,
  createImageElement,
  getBrandLogoAsset,
  importElements,
  moveSlot as moveSlotPure,
  removeSlot as removeSlotPure,
  setSlotTargets as setSlotTargetsPure,
  updateSlot as updateSlotPure,
  centerOnPage,
  COLOR_PATTERN,
  type BrandKit,
  type Id,
  type TemplateSlot,
} from '@plakat/schema';
import { errorMessage, targetIds, type ActionContext } from './internal.ts';
import type { CommitOptions, EditorActions } from './types.ts';

type TemplateKeys =
  | 'convertToTemplate'
  | 'convertToDesign'
  | 'setTemplateCategory'
  | 'addSlot'
  | 'updateSlot'
  | 'setSlotTargets'
  | 'removeSlot'
  | 'moveSlot'
  | 'fillSlot'
  | 'setBrandKits'
  | 'upsertBrandKit'
  | 'removeBrandKit'
  | 'setActiveBrandKit'
  | 'applyBrandKit'
  | 'insertBrandLogo'
  | 'applyColor'
  | 'applyBrandFont';

export function createTemplateActions(ctx: ActionContext): Pick<EditorActions, TemplateKeys> {
  const { get, set, commit } = ctx;

  /** Runs a commit; user-facing errors (TemplateError, ...) are stored in lastError and rethrown. */
  const guarded = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      set({ lastError: errorMessage(e) });
      throw e;
    }
  };

  const kitById = (kitId?: Id): BrandKit | undefined => {
    const s = get();
    const id = kitId ?? s.activeBrandKitId ?? s.brandKits[0]?.id;
    return s.brandKits.find((k) => k.id === id);
  };

  return {
    convertToTemplate(category) {
      commit('Convert to template', (_d, base) => convertToTemplatePure(base, category === undefined ? {} : { category }));
    },
    convertToDesign() {
      commit('Convert to design', (d) => {
        d.kind = 'design';
        d.template = null;
      });
    },
    setTemplateCategory(category) {
      guarded(() =>
        commit('Template category', (d) => {
          if (!d.template) throw new Error('Not a template');
          d.template.category = category;
        }),
      );
    },
    addSlot(spec) {
      let slot: TemplateSlot | null = null;
      guarded(() =>
        commit('Add slot', (_d, base) => {
          const r = addSlotPure(base, spec);
          slot = r.slot;
          return r.document;
        }),
      );
      return slot!;
    },
    updateSlot(slotId, patch) {
      guarded(() => commit('Edit slot', (_d, base) => updateSlotPure(base, slotId, patch), { coalesceKey: `slot:${slotId}` }));
    },
    setSlotTargets(slotId, targets) {
      guarded(() => commit('Slot targets', (_d, base) => setSlotTargetsPure(base, slotId, targets)));
    },
    removeSlot(slotId) {
      guarded(() => commit('Remove slot', (_d, base) => removeSlotPure(base, slotId)));
    },
    moveSlot(slotId, index) {
      guarded(() => commit('Reorder slots', (_d, base) => moveSlotPure(base, slotId, index)));
    },
    fillSlot(slotId, fill) {
      const opts: CommitOptions = 'text' in fill ? { coalesceKey: `fill:${slotId}` } : {};
      guarded(() => commit('Fill slot', (_d, base) => applySlotFill(base, slotId, fill), opts));
    },

    // --- brand kits ----------------------------------------------------------------
    setBrandKits(kits) {
      const active = get().activeBrandKitId;
      set({ brandKits: [...kits], activeBrandKitId: kits.some((k) => k.id === active) ? active : (kits[0]?.id ?? null) });
    },
    upsertBrandKit(kit) {
      const kits = get().brandKits;
      const i = kits.findIndex((k) => k.id === kit.id);
      const next = i === -1 ? [...kits, kit] : kits.map((k) => (k.id === kit.id ? kit : k));
      set({ brandKits: next, activeBrandKitId: get().activeBrandKitId ?? kit.id });
    },
    removeBrandKit(kitId) {
      const next = get().brandKits.filter((k) => k.id !== kitId);
      const active = get().activeBrandKitId;
      set({ brandKits: next, activeBrandKitId: active === kitId ? (next[0]?.id ?? null) : active });
    },
    setActiveBrandKit(kitId) {
      set({ activeBrandKitId: kitId });
    },
    applyBrandKit(kitId, options) {
      const kit = kitById(kitId);
      if (!kit) return;
      commit('Apply brand kit', (_d, base) => applyBrandKitPure(base, kit, options));
    },
    insertBrandLogo(logoId, kitId) {
      const kit = kitById(kitId);
      const hit = kit ? getBrandLogoAsset(kit, logoId) : null;
      if (!kit || !hit) return null;
      const s = get();
      const logo = kit.logos.find((l) => l.id === logoId);
      const el = centerOnPage(
        createImageElement(hit.assetId, hit.asset, { name: logo?.name ?? '', objectFit: 'contain', maxSize: Math.min(s.document.size.width, s.document.size.height) * 0.3 }, { page: s.document.size }),
        s.document.size,
      );
      let newId: Id | null = null;
      const opts: CommitOptions = { activePageId: s.activePageId };
      commit(
        'Insert logo',
        (_d, base) => {
          const r = importElements(base, s.activePageId, { elements: [el], assets: { [hit.assetId]: hit.asset } });
          newId = r.elementIds[0] ?? null;
          opts.select = r.elementIds;
          return r.document;
        },
        opts,
      );
      return newId;
    },
    applyColor(color, options = {}) {
      if (!COLOR_PATTERN.test(color)) return;
      const c = color.toLowerCase();
      const ids = new Set(targetIds(ctx, options.ids));
      if (!ids.size) return;
      commit(
        'Color',
        (d) => {
          for (const page of d.pages) {
            for (const el of page.elements) {
              if (!ids.has(el.id)) continue;
              if (el.type === 'text') el.fill = c;
              else if (el.type === 'shape') {
                if (options.property === 'stroke' || (el.shape === 'line' && options.property !== 'fill')) el.stroke = c;
                else el.fill = c;
              }
            }
          }
        },
        { coalesceKey: `color:${[...ids].sort().join(',')}:${options.property ?? ''}` },
      );
    },
    applyBrandFont(role, options = {}) {
      const kit = kitById(options.kitId);
      const font = kit?.fonts.find((f) => f.role === role);
      if (!font) return;
      const ids = new Set(targetIds(ctx, options.ids));
      commit('Brand font', (d) => {
        for (const page of d.pages) {
          for (const el of page.elements) {
            if (!ids.has(el.id) || el.type !== 'text') continue;
            el.fontFamily = font.family;
            el.fontWeight = font.weight;
            el.fontStyle = font.style;
          }
        }
      });
    },
  };
}
