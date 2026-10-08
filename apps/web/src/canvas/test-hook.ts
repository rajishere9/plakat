/**
 * `window.__plakat` (render-export-pipeline.md §6.2): the e2e hook. Installed by <Workspace>
 * (harmless in production: it only reads state and rasterizes the editor's own scenes).
 */
import type { ExportScaleId, Id, PlakatDocument } from '@plakat/schema';
import type { EditorStore } from '../store/editor-store.ts';
import type { WorkspaceController, WorkspaceStatus } from './controller.ts';
import type { ViewState } from './viewport.ts';

export interface PlakatTestHook {
  /** Resolves after the readiness barrier (and any later resource loads) and a draw. */
  ready(): Promise<void>;
  /** PNG bytes of the editor's own PageScene via rasterizePage(scene, scale). */
  snapshotContentLayer(pageId: Id, scale: number | ExportScaleId): Promise<Uint8Array>;
  /** Same as snapshotContentLayer, base64-encoded (convenient across page.evaluate). */
  snapshotContentLayerBase64(pageId: Id, scale: number | ExportScaleId): Promise<string>;
  getDocument(): PlakatDocument;
  store: EditorStore;
  controller: WorkspaceController;
  getView(): ViewState;
  setPan(panX: number, panY: number): void;
  scrollToPage(pageId: Id): void;
  getStatus(): WorkspaceStatus;
}

declare global {
  interface Window {
    __plakat?: PlakatTestHook;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function createTestHook(controller: WorkspaceController, store: EditorStore): PlakatTestHook {
  return {
    ready: () => controller.ready(),
    snapshotContentLayer: (pageId, scale) => controller.snapshotPage(pageId, scale),
    snapshotContentLayerBase64: async (pageId, scale) => bytesToBase64(await controller.snapshotPage(pageId, scale)),
    getDocument: () => store.getState().document,
    store,
    controller,
    getView: () => controller.getView(),
    setPan: (x, y) => controller.setPan(x, y, { clamp: false }),
    scrollToPage: (pageId) => controller.scrollToPage(pageId),
    getStatus: () => controller.getStatus(),
  };
}

/** Installs `window.__plakat`; returns an uninstaller (only removes its own hook). */
export function installTestHook(controller: WorkspaceController, store: EditorStore): () => void {
  if (typeof window === 'undefined') return () => {};
  const hook = createTestHook(controller, store);
  window.__plakat = hook;
  return () => {
    if (window.__plakat === hook) delete window.__plakat;
  };
}
