/**
 * The editor store: zustand 5 (vanilla store + React hook). Document mutations go
 * through ONE function, `actions.commit(label, recipe, options)`, which records
 * immer patches for undo/redo and publishes `lastChange` for the canvas.
 */
import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createDocument, type Id, type PlakatDocument } from '@plakat/schema';
import { clampZoom, computeFitZoom, nextZoomStep } from '../lib/zoom.ts';
import { diffDocuments, fullChange, reconcileInto, restoreSharing } from './changes.ts';
import { History, HISTORY_LIMIT, type SelectionSnapshot } from './history.ts';
import { expandGroups, getActivePage, type ActionContext } from './internal.ts';
import { createElementActions } from './actions-elements.ts';
import { createArrangeActions } from './actions-arrange.ts';
import { createPageActions } from './actions-pages.ts';
import { createTemplateActions } from './actions-templates.ts';
import type { CommitOptions, CommitRecipe, CommitResult, DocumentChange, EditorActions, EditorState } from './types.ts';

enablePatches();

export type EditorStore = StoreApi<EditorState>;

export interface CreateEditorStoreOptions {
  /** Initial document (default: a blank Instagram post). */
  document?: PlakatDocument;
  /** Clock for coalescing (tests). */
  now?: () => number;
  historyLimit?: number;
}

function sanitizeSelection(doc: PlakatDocument, snap: SelectionSnapshot): SelectionSnapshot {
  const page = doc.pages.find((p) => p.id === snap.pageId) ?? doc.pages[0]!;
  const ids = snap.ids.filter((id) => page.elements.some((e) => e.id === id));
  return { ids, pageId: page.id };
}

/** Active page after a change: unchanged if it still exists, else the page now at its old index (clamped). */
function survivingPageId(prev: PlakatDocument, next: PlakatDocument, pageId: Id): Id {
  if (next.pages.some((p) => p.id === pageId)) return pageId;
  const oldIndex = Math.max(0, prev.pages.findIndex((p) => p.id === pageId));
  return next.pages[Math.min(oldIndex, next.pages.length - 1)]!.id;
}

export function createEditorStore(options: CreateEditorStoreOptions = {}): EditorStore {
  const now = options.now ?? (() => Date.now());
  const history = new History(options.historyLimit ?? HISTORY_LIMIT);
  let changeSeq = 0;
  const initialDoc = options.document ?? createDocument();

  return createStore<EditorState>()((set, get) => {
    const historyFlags = () => ({
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    });

    /** Mode/hover cleanup after the document or selection changed. */
    const modeCleanup = (doc: PlakatDocument, selectedIds: Id[]) => {
      const s = get();
      const exists = (id: Id | null) => !!id && doc.pages.some((p) => p.elements.some((e) => e.id === id));
      return {
        textEditingId: s.textEditingId && exists(s.textEditingId) && selectedIds.includes(s.textEditingId) ? s.textEditingId : null,
        cropModeId: s.cropModeId && exists(s.cropModeId) && selectedIds.includes(s.cropModeId) ? s.cropModeId : null,
        hoveredId: exists(s.hoveredId) ? s.hoveredId : null,
      };
    };

    const dirtyStatus = () => {
      const st = get().saveStatus;
      return st === 'saved' || st === 'idle' ? { saveStatus: 'unsaved' as const } : {};
    };

    const applyDocumentChange = (
      next: PlakatDocument,
      change: DocumentChange,
      selection: SelectionSnapshot,
      bumpRevision: boolean,
    ) => {
      set({
        document: next,
        docRevision: bumpRevision ? get().docRevision + 1 : get().docRevision,
        lastChange: change,
        selectedIds: selection.ids,
        activePageId: selection.pageId,
        ...modeCleanup(next, selection.ids),
        ...historyFlags(),
        ...(bumpRevision ? dirtyStatus() : {}),
      });
      if (change.sizeChanged && get().zoomMode === 'fit') actions.zoomToFit();
    };

    const commit = (label: string, recipe: CommitRecipe, opts: CommitOptions = {}): CommitResult => {
      const state = get();
      const base = state.document;
      const [next, patches, inversePatches] = produceWithPatches(base, (draft) => {
        const result = recipe(draft, base);
        if (result && (result as unknown) !== draft && result !== base) {
          reconcileInto(draft as unknown as Record<string, unknown>, base as unknown as Record<string, unknown>, result as unknown as Record<string, unknown>);
        }
      });
      const changed = patches.length > 0;
      const before: SelectionSnapshot = { ids: state.selectedIds, pageId: state.activePageId };

      let pageId = survivingPageId(base, next, opts.activePageId ?? state.activePageId);
      let ids = opts.select ?? state.selectedIds;
      if (opts.select && opts.select.length > 0 && !opts.activePageId) {
        const first = next.pages.find((p) => p.elements.some((e) => e.id === opts.select![0]));
        if (first) pageId = first.id;
      }
      const after = sanitizeSelection(next, { ids, pageId });
      ids = after.ids;

      const touched = opts.touched ?? [];
      if (!changed && touched.length === 0) {
        if (after.pageId !== state.activePageId || after.ids.join() !== state.selectedIds.join()) {
          set({ selectedIds: after.ids, activePageId: after.pageId, ...modeCleanup(base, after.ids) });
        }
        return { changed: false, document: base };
      }
      if (changed) {
        history.push(
          { label, patches, inversePatches, selectionBefore: before, selectionAfter: after, coalesceKey: opts.coalesceKey ?? null, time: now() },
          { coalesceKey: opts.coalesceKey ?? null, coalesceWindowMs: opts.coalesceWindowMs, merge: opts.merge },
        );
      }
      const change = diffDocuments(base, next, { seq: ++changeSeq, source: 'commit', label, touched });
      applyDocumentChange(next, change, after, changed);
      return { changed, document: next };
    };

    const step = (direction: 'undo' | 'redo'): boolean => {
      const entry = direction === 'undo' ? history.undo() : history.redo();
      if (!entry) return false;
      const base = get().document;
      const next = restoreSharing(base, applyPatches(base, direction === 'undo' ? entry.inversePatches : entry.patches));
      const selection = sanitizeSelection(next, direction === 'undo' ? entry.selectionBefore : entry.selectionAfter);
      const change = diffDocuments(base, next, { seq: ++changeSeq, source: direction, label: entry.label });
      applyDocumentChange(next, change, selection, true);
      return true;
    };

    const ctx: ActionContext = {
      get,
      set: (partial) => set(partial),
      commit,
      now,
    };

    const actions: EditorActions = {
      commit,
      undo: () => step('undo'),
      redo: () => step('redo'),
      breakCoalescing: () => history.seal(),
      clearHistory: () => {
        history.clear();
        set(historyFlags());
      },

      // --- lifecycle ---------------------------------------------------------
      openDocument(doc, o = {}) {
        history.clear();
        const firstPage = doc.pages[0]!;
        const revision = get().docRevision + 1;
        set({
          document: doc,
          docRevision: revision,
          savedRevision: revision,
          lastChange: fullChange(doc, ++changeSeq),
          ...historyFlags(),
          selectedIds: [],
          activePageId: firstPage.id,
          hoveredId: null,
          textEditingId: null,
          cropModeId: null,
          projectId: o.projectId ?? null,
          projectKind: o.projectKind ?? (doc.kind === 'template' ? 'template' : 'project'),
          version: o.version ?? null,
          lastSavedAt: o.updatedAt ?? null,
          saveStatus: o.readonly ? 'readonly' : o.projectId ? 'saved' : 'idle',
          saveError: null,
          lastError: null,
        });
        if (get().zoomMode === 'fit') actions.zoomToFit();
      },
      newDocument(size, o = {}) {
        actions.openDocument(createDocument(size ?? undefined, { title: o.title, kind: o.kind }));
      },
      setTitle(title) {
        commit('Rename design', (d) => {
          d.meta.title = title.slice(0, 500);
        }, { coalesceKey: 'title' });
      },

      setPersistenceState(patch) {
        set(patch);
      },

      // --- selection ------------------------------------------------------------
      select(ids, o = {}) {
        const s = get();
        const doc = s.document;
        const expanded = o.expandGroups === false ? [...ids] : expandGroups(doc, ids);
        const mode = o.mode ?? 'replace';
        let next: Id[];
        if (mode === 'replace') next = expanded;
        else if (mode === 'add') next = [...s.selectedIds, ...expanded.filter((id) => !s.selectedIds.includes(id))];
        else if (mode === 'remove') next = s.selectedIds.filter((id) => !expanded.includes(id));
        else {
          const allSelected = expanded.every((id) => s.selectedIds.includes(id));
          next = allSelected ? s.selectedIds.filter((id) => !expanded.includes(id)) : [...s.selectedIds, ...expanded.filter((id) => !s.selectedIds.includes(id))];
        }
        // Selection lives on one page: the page of the first newly given id (else the active page).
        const pageOf = (id: Id) => doc.pages.find((p) => p.elements.some((e) => e.id === id))?.id;
        const pageId = (mode === 'replace' || mode === 'add' || mode === 'toggle' ? pageOf(expanded[0] ?? '') : undefined) ?? s.activePageId;
        const snap = sanitizeSelection(doc, { ids: next, pageId });
        set({ selectedIds: snap.ids, activePageId: snap.pageId, ...modeCleanup(doc, snap.ids) });
      },
      selectAll() {
        const page = getActivePage(get());
        const ids = page.elements.filter((e) => !e.hidden && !e.locked).map((e) => e.id);
        set({ selectedIds: ids, textEditingId: null, cropModeId: null });
      },
      selectNone() {
        set({ selectedIds: [], textEditingId: null, cropModeId: null });
      },
      setActivePage(pageId) {
        const s = get();
        if (!s.document.pages.some((p) => p.id === pageId) || pageId === s.activePageId) return;
        set({ activePageId: pageId, selectedIds: [], textEditingId: null, cropModeId: null });
      },
      setHovered(id) {
        if (get().hoveredId !== id) set({ hoveredId: id });
      },
      escape() {
        const s = get();
        if (s.textEditingId) actions.stopTextEditing();
        else if (s.cropModeId) actions.exitCropMode();
        else if (s.selectedIds.length) actions.selectNone();
        else if (s.activePanel) set({ activePanel: null });
      },

      // --- modes ----------------------------------------------------------------
      startTextEditing(id) {
        const hit = get().document.pages.flatMap((p) => p.elements).find((e) => e.id === id);
        if (!hit || hit.type !== 'text' || hit.locked) return;
        actions.select([id], { expandGroups: false });
        history.seal();
        set({ textEditingId: id, cropModeId: null });
      },
      stopTextEditing() {
        if (get().textEditingId) {
          history.seal();
          set({ textEditingId: null });
        }
      },
      enterCropMode(id) {
        const hit = get().document.pages.flatMap((p) => p.elements).find((e) => e.id === id);
        if (!hit || hit.type !== 'image' || hit.locked) return;
        actions.select([id], { expandGroups: false });
        set({ cropModeId: id, textEditingId: null });
      },
      exitCropMode() {
        if (get().cropModeId) set({ cropModeId: null });
      },

      // --- view -------------------------------------------------------------------
      setZoom(zoom) {
        set({ zoom: clampZoom(zoom), zoomMode: 'manual' });
      },
      zoomIn() {
        set({ zoom: nextZoomStep(get().zoom, 1), zoomMode: 'manual' });
      },
      zoomOut() {
        set({ zoom: nextZoomStep(get().zoom, -1), zoomMode: 'manual' });
      },
      zoomToFit() {
        const s = get();
        const zoom = s.viewportSize ? computeFitZoom(s.document.size, s.viewportSize) : s.zoom;
        set({ zoom, zoomMode: 'fit' });
      },
      zoomTo100() {
        set({ zoom: 1, zoomMode: 'manual' });
      },
      setViewportSize(size) {
        const prev = get().viewportSize;
        if (prev && prev.width === size.width && prev.height === size.height) return;
        set({ viewportSize: { width: size.width, height: size.height } });
        if (get().zoomMode === 'fit') actions.zoomToFit();
      },

      // --- UI ----------------------------------------------------------------------
      setActivePanel(panel) {
        set({ activePanel: panel });
      },
      togglePanel(panel) {
        set({ activePanel: get().activePanel === panel ? null : panel });
      },
      setShortcutsHelpOpen(open) {
        set({ shortcutsHelpOpen: open });
      },
      toggleShortcutsHelp() {
        set({ shortcutsHelpOpen: !get().shortcutsHelpOpen });
      },
      setError(message) {
        set({ lastError: message });
      },

      ...createElementActions(ctx),
      ...createArrangeActions(ctx),
      ...createPageActions(ctx),
      ...createTemplateActions(ctx),
    };

    return {
      document: initialDoc,
      docRevision: 0,
      lastChange: fullChange(initialDoc, ++changeSeq),
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
      projectId: null,
      projectKind: initialDoc.kind === 'template' ? 'template' : 'project',
      version: null,
      saveStatus: 'idle',
      saveError: null,
      lastSavedAt: null,
      savedRevision: 0,
      selectedIds: [],
      activePageId: initialDoc.pages[0]!.id,
      hoveredId: null,
      textEditingId: null,
      cropModeId: null,
      zoom: 1,
      zoomMode: 'fit',
      viewportSize: null,
      clipboard: null,
      brandKits: [],
      activeBrandKitId: null,
      activePanel: null,
      shortcutsHelpOpen: false,
      lastError: null,
      actions,
    };
  });
}

/** The app-wide store instance (non-React access: editorStore.getState().actions.addText()). */
export const editorStore: EditorStore = createEditorStore();

/** Shorthand for `editorStore.getState().actions` (stable object). */
export const editorActions: EditorActions = editorStore.getState().actions;

/**
 * React hook: `useEditor((s) => s.selectedIds)`. Selectors must return stable
 * references (use the memoized selectors in store/selectors.ts or `useShallow`).
 */
export function useEditor<T>(selector: (state: EditorState) => T, store: EditorStore = editorStore): T {
  return useStore(store, selector);
}

/** The stable actions object of a store. */
export function useEditorActions(store: EditorStore = editorStore): EditorActions {
  return useStore(store, (s) => s.actions);
}

/**
 * Subscribes to document change notifications (commit/undo/redo/load), called
 * synchronously after the state update with the change and the new document.
 */
export function onDocumentChange(
  listener: (change: DocumentChange, document: PlakatDocument, state: EditorState) => void,
  store: EditorStore = editorStore,
): () => void {
  return store.subscribe((state, prev) => {
    if (state.lastChange && state.lastChange !== prev.lastChange) listener(state.lastChange, state.document, state);
  });
}
