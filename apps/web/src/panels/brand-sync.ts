/**
 * Brand-kit persistence: the store holds the kits (setBrandKits / upsertBrandKit);
 * this module loads them from the server and writes edits back (debounced PUT per kit).
 */
import { createBrandKit, type BrandKit } from '@plakat/schema';
import type { ApiClient } from '../api/index.ts';
import type { EditorStore } from '../store/index.ts';
import { errorMessage, toast } from '../app/toasts.tsx';

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const SAVE_DELAY = 600;

export async function loadBrandKits(api: Pick<ApiClient, 'listBrandKits'>, store: EditorStore): Promise<void> {
  const kits = await api.listBrandKits();
  store.getState().actions.setBrandKits(kits);
}

/** Applies an edited kit locally right away and saves it to the server shortly after. */
export function updateKit(kit: BrandKit, api: Pick<ApiClient, 'updateBrandKit'>, store: EditorStore): void {
  store.getState().actions.upsertBrandKit(kit);
  const prev = timers.get(kit.id);
  if (prev) clearTimeout(prev);
  timers.set(
    kit.id,
    setTimeout(() => {
      timers.delete(kit.id);
      const latest = store.getState().brandKits.find((k) => k.id === kit.id);
      if (!latest) return;
      api.updateBrandKit(latest.id, latest).catch((e) => toast.error('Brand kit not saved', { detail: errorMessage(e), key: 'brand-save' }));
    }, SAVE_DELAY),
  );
}

export async function createKit(name: string, api: Pick<ApiClient, 'createBrandKit'>, store: EditorStore): Promise<BrandKit> {
  const created = await api.createBrandKit(createBrandKit(name));
  store.getState().actions.upsertBrandKit(created);
  store.getState().actions.setActiveBrandKit(created.id);
  return created;
}

export async function deleteKit(id: string, api: Pick<ApiClient, 'deleteBrandKit'>, store: EditorStore): Promise<void> {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  await api.deleteBrandKit(id);
  store.getState().actions.removeBrandKit(id);
}
