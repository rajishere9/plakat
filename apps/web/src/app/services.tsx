/**
 * App services (store, API client, persistence, renderer env) provided through React
 * context so panels can be tested against isolated stores and fake clients.
 */
import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { RenderEnv } from '@plakat/renderer';
import type { Id, PlakatDocument } from '@plakat/schema';
import { api as defaultApi, createPersistence, type ApiClient, type Persistence } from '../api/index.ts';
import { editorStore, useEditor, type EditorState, type EditorStore } from '../store/index.ts';
import { getRenderEnv } from '../canvas/render-env.ts';
import { renderPagePreview } from './preview.ts';

export interface AppServices {
  store: EditorStore;
  api: ApiClient;
  persistence: Persistence;
  /** Shared browser render env (font/image caches), created lazily. */
  getRenderEnv: () => RenderEnv;
  /** PNG preview of a page fitted into maxSide px. Rejects when it cannot render. */
  renderPreview: (doc: PlakatDocument, pageId: Id, maxSide: number, options?: { strictFonts?: boolean }) => Promise<Blob>;
}

/** The app-wide browser render env shared with the canvas (one font/image cache for canvas, previews and exports). */
export const getSharedRenderEnv: () => RenderEnv = getRenderEnv;

/** Max side of server thumbnails (projects and templates). */
export const THUMBNAIL_MAX_SIDE = 480;

export function createAppServices(overrides: Partial<AppServices> = {}): AppServices {
  const store = overrides.store ?? editorStore;
  const api = overrides.api ?? defaultApi;
  const getRenderEnv = overrides.getRenderEnv ?? getSharedRenderEnv;
  const renderPreview =
    overrides.renderPreview ?? ((doc: PlakatDocument, pageId: Id, maxSide: number, options?: { strictFonts?: boolean }) => renderPagePreview(doc, pageId, maxSide, getRenderEnv(), options));
  const persistence =
    overrides.persistence ??
    createPersistence({
      store,
      client: api,
      thumbnail: async (doc) => {
        const page = doc.pages[0];
        if (!page) return null;
        try {
          return await renderPreview(doc, page.id, THUMBNAIL_MAX_SIDE);
        } catch (e) {
          console.warn('[plakat] thumbnail render failed', e);
          return null;
        }
      },
    });
  return { store, api, persistence, getRenderEnv, renderPreview };
}

let defaultServices: AppServices | null = null;
export function getDefaultServices(): AppServices {
  return (defaultServices ??= createAppServices());
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ value, children }: { value: AppServices; children: ReactNode }): JSX.Element {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  return useContext(ServicesContext) ?? getDefaultServices();
}

export function useStoreApi(): EditorStore {
  return useServices().store;
}

/** useEditor bound to the store from context. Selectors must return stable references. */
export function useEd<T>(selector: (s: EditorState) => T): T {
  return useEditor(selector, useStoreApi());
}

export function useActions(): EditorState['actions'] {
  return useEd((s) => s.actions);
}
