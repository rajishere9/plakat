/**
 * Persistence: autosave (debounced PUT with baseVersion, 409 -> 'conflict'), project /
 * template loading, creating projects from presets or templates, save-as-template and
 * thumbnail uploads. Talks to the store only through its public state/actions.
 */
import {
  assertValidDocument,
  cloneWithNewIds,
  createDocument,
  instantiateTemplate,
  normalizeDocument,
  pruneUnusedAssets,
  saveAsTemplate as saveAsTemplatePure,
  type Id,
  type PageSize,
  type PlakatDocument,
  type PresetId,
  type SlotFills,
  type SlotSpec,
} from '@plakat/schema';
import { editorStore, type EditorStore } from '../store/editor-store.ts';
import type { EditorState } from '../store/types.ts';
import { api, ApiError, type ApiClient } from './client.ts';

/** Renders a PNG thumbnail of the document's first page (provided by the canvas / renderer). */
export type ThumbnailProducer = (doc: PlakatDocument) => Promise<Blob | null>;

export interface PersistenceOptions {
  store?: EditorStore;
  client?: ApiClient;
  /** Autosave debounce after the last commit (default 1000 ms). */
  debounceMs?: number;
  /** First retry delay after a failed save; doubles up to retryMaxMs (default 2000 / 30000). */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Delay between a successful save and the thumbnail upload (default 3000 ms). */
  thumbnailDelayMs?: number;
  thumbnail?: ThumbnailProducer | null;
  /** Autosave a document without a server id by creating it (POST) (default true). */
  autoCreate?: boolean;
}

export type CreateProjectSource =
  | { preset?: PresetId | PageSize; title?: string }
  | { templateId: string; fills?: SlotFills; title?: string }
  | { template: PlakatDocument; fills?: SlotFills; title?: string }
  | { document: PlakatDocument };

export type ConflictStrategy =
  /** Discard local changes and load the server version. */
  | 'reload'
  /** Keep local changes: re-read the server version number and overwrite it. */
  | 'overwrite'
  /** Keep both: save the local document as a NEW project (fresh ids) and open it. */
  | 'saveAsCopy';

export interface Persistence {
  /** Starts autosave (idempotent). Returns stop(). */
  start(): () => void;
  stop(): void;
  /** Saves immediately (Mod+S). Resolves when the server has the current revision or the save failed. */
  saveNow(): Promise<void>;
  /** Runs a pending debounced save now and waits for in-flight saves. */
  flush(): Promise<void>;
  hasUnsavedChanges(): boolean;
  loadProject(id: string): Promise<void>;
  /** Opens a template for editing (built-ins open read-only). */
  openTemplate(id: string): Promise<{ builtIn: boolean }>;
  /** Creates a project on the server and opens it; returns its id. */
  createProject(source?: CreateProjectSource): Promise<string>;
  /** "Save a copy as template" (schema saveAsTemplate): POSTs a new template; the open document is unchanged. */
  saveAsTemplate(input: { slots: ReadonlyArray<Id | SlotSpec>; title?: string; category?: string | null }): Promise<{ id: string; document: PlakatDocument }>;
  resolveConflict(strategy: ConflictStrategy): Promise<void>;
  setThumbnailProducer(fn: ThumbnailProducer | null): void;
  uploadThumbnailNow(): Promise<void>;
  /** Shows the browser's "leave site?" prompt while changes are unsaved. Returns cleanup. */
  installBeforeUnload(): () => void;
}

export function createPersistence(options: PersistenceOptions = {}): Persistence {
  const store = options.store ?? editorStore;
  const client = options.client ?? api;
  const debounceMs = options.debounceMs ?? 1000;
  const retryBaseMs = options.retryBaseMs ?? 2000;
  const retryMaxMs = options.retryMaxMs ?? 30_000;
  const thumbnailDelayMs = options.thumbnailDelayMs ?? 3000;
  const autoCreate = options.autoCreate !== false;
  let thumbnail: ThumbnailProducer | null = options.thumbnail ?? null;

  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let retryDelay = retryBaseMs;
  let thumbRevision = -1;

  const S = () => store.getState();
  const setP = (patch: Parameters<EditorState['actions']['setPersistenceState']>[0]) => S().actions.setPersistenceState(patch);
  const dirty = () => S().docRevision !== S().savedRevision;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const canAutosave = () => {
    const s = S();
    if (s.saveStatus === 'conflict' || s.saveStatus === 'readonly') return false;
    return !!s.projectId || autoCreate;
  };

  const schedule = (delay = debounceMs) => {
    clearTimer();
    if (!canAutosave() || !dirty()) return;
    timer = setTimeout(() => {
      timer = null;
      void saveNow();
    }, delay);
  };

  const scheduleThumbnail = () => {
    if (!thumbnail) return;
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      thumbTimer = null;
      void uploadThumbnailNow();
    }, thumbnailDelayMs);
  };

  async function uploadThumbnailNow(): Promise<void> {
    const s = S();
    if (!thumbnail || !s.projectId || s.saveStatus === 'readonly') return;
    const rev = s.docRevision;
    if (rev === thumbRevision) return;
    try {
      const blob = await thumbnail(s.document);
      if (!blob) return;
      if (s.projectKind === 'template') await client.uploadTemplateThumbnail(s.projectId, blob);
      else await client.uploadProjectThumbnail(s.projectId, blob);
      thumbRevision = rev;
    } catch (e) {
      console.warn('[plakat] thumbnail upload failed', e);
    }
  }

  async function performSave(): Promise<void> {
    const s = S();
    if (s.saveStatus === 'conflict' || s.saveStatus === 'readonly') return;
    const rev = s.docRevision;
    let doc: PlakatDocument;
    try {
      // Unused registry entries (replaced/deleted images) are not persisted; undo history
      // keeps its own copies, and the next save after an undo sends them again.
      doc = normalizeDocument(pruneUnusedAssets(s.document));
      assertValidDocument(doc);
    } catch (e) {
      setP({ saveStatus: 'error', saveError: e instanceof Error ? e.message : String(e) });
      return;
    }
    setP({ saveStatus: 'saving', saveError: null });
    try {
      if (!s.projectId) {
        if (s.projectKind === 'template') {
          const r = await client.createTemplate(doc);
          setP({ projectId: r.id, version: null });
        } else {
          const r = await client.createProject(doc);
          setP({ projectId: r.id, version: r.version, lastSavedAt: r.updatedAt });
        }
      } else if (s.projectKind === 'template') {
        await client.updateTemplate(s.projectId, doc);
        setP({ lastSavedAt: new Date().toISOString() });
      } else {
        const r = await client.saveProject(s.projectId, doc, s.version);
        setP({ version: r.version, lastSavedAt: r.updatedAt });
      }
      retryDelay = retryBaseMs;
      const nowDirty = S().docRevision !== rev;
      setP({ savedRevision: rev, saveStatus: nowDirty ? 'unsaved' : 'saved', saveError: null });
      if (nowDirty) schedule();
      scheduleThumbnail();
    } catch (e) {
      if (e instanceof ApiError && e.isConflict) {
        clearTimer();
        setP({ saveStatus: 'conflict', saveError: e.message });
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        clearTimer();
        setP({ saveStatus: 'readonly', saveError: e.message });
        return;
      }
      setP({ saveStatus: 'error', saveError: e instanceof Error ? e.message : String(e) });
      schedule(retryDelay);
      retryDelay = Math.min(retryMaxMs, retryDelay * 2);
    }
  }

  async function saveNow(): Promise<void> {
    clearTimer();
    if (inFlight) {
      await inFlight;
      if (dirty()) return saveNow();
      return;
    }
    if (!dirty() && S().projectId) return;
    if (!S().projectId && !dirty() && !autoCreate) return;
    inFlight = performSave().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimer();
      await saveNow();
    } else if (inFlight) {
      await inFlight;
    }
  }

  function start(): () => void {
    if (!unsubscribe) {
      unsubscribe = store.subscribe((state, prev) => {
        if (state.docRevision !== prev.docRevision) {
          if (state.projectId !== prev.projectId || state.document.id !== prev.document.id) {
            // A different document was opened: drop timers belonging to the old one.
            clearTimer();
            retryDelay = retryBaseMs;
            thumbRevision = -1;
          }
          schedule();
        }
      });
    }
    return stop;
  }

  function stop(): void {
    unsubscribe?.();
    unsubscribe = null;
    clearTimer();
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = null;
  }

  async function loadProject(id: string): Promise<void> {
    await flush();
    const r = await client.getProject(id);
    S().actions.openDocument(r.document, { projectId: r.id, projectKind: 'project', version: r.version, updatedAt: r.updatedAt });
  }

  async function openTemplate(id: string): Promise<{ builtIn: boolean }> {
    await flush();
    const r = await client.getTemplate(id);
    S().actions.openDocument(r.document, { projectId: r.id, projectKind: 'template', readonly: r.builtIn });
    return { builtIn: r.builtIn };
  }

  async function createProject(source: CreateProjectSource = {}): Promise<string> {
    await flush();
    let doc: PlakatDocument;
    if ('document' in source) doc = source.document;
    else if ('templateId' in source) {
      const t = await client.getTemplate(source.templateId);
      doc = instantiateTemplate(t.document, source.fills ?? {}, source.title !== undefined ? { title: source.title } : {});
    } else if ('template' in source) {
      doc = instantiateTemplate(source.template, source.fills ?? {}, source.title !== undefined ? { title: source.title } : {});
    } else {
      doc = createDocument(source.preset, source.title !== undefined ? { title: source.title } : {});
    }
    const r = await client.createProject(normalizeDocument(doc));
    S().actions.openDocument(r.document, { projectId: r.id, projectKind: 'project', version: r.version, updatedAt: r.updatedAt });
    // A new design (often from a template) gets its gallery thumbnail without waiting for an edit.
    scheduleThumbnail();
    return r.id;
  }

  async function saveAsTemplate(input: { slots: ReadonlyArray<Id | SlotSpec>; title?: string; category?: string | null }) {
    const current = S().document;
    const tpl = saveAsTemplatePure(current, input.slots, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
    });
    const r = await client.createTemplate(tpl);
    if (thumbnail) {
      try {
        const blob = await thumbnail(current);
        if (blob) await client.uploadTemplateThumbnail(r.id, blob);
      } catch (e) {
        console.warn('[plakat] template thumbnail upload failed', e);
      }
    }
    return { id: r.id, document: tpl };
  }

  async function resolveConflict(strategy: ConflictStrategy): Promise<void> {
    const s = S();
    if (!s.projectId) return;
    if (strategy === 'reload') {
      const r = await client.getProject(s.projectId);
      S().actions.openDocument(r.document, { projectId: r.id, projectKind: 'project', version: r.version, updatedAt: r.updatedAt });
      return;
    }
    if (strategy === 'overwrite') {
      const r = await client.getProject(s.projectId);
      setP({ version: r.version, saveStatus: 'unsaved', saveError: null });
      await saveNow();
      return;
    }
    const { document } = cloneWithNewIds(s.document);
    await createProject({ document: { ...document, meta: { ...document.meta, title: `${document.meta.title} (copy)`.slice(0, 500) } } });
  }

  function installBeforeUnload(): () => void {
    if (typeof window === 'undefined') return () => {};
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirty() || S().saveStatus === 'readonly') return;
      void flush();
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }

  return {
    start,
    stop,
    saveNow,
    flush,
    hasUnsavedChanges: dirty,
    loadProject,
    openTemplate,
    createProject,
    saveAsTemplate,
    resolveConflict,
    setThumbnailProducer: (fn) => {
      thumbnail = fn;
    },
    uploadThumbnailNow,
    installBeforeUnload,
  };
}
