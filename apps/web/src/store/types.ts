import type { Draft } from 'immer';
import type {
  ApplyBrandKitOptions,
  Asset,
  AssetSource,
  BrandFontRole,
  BrandKit,
  Color,
  CropRect,
  Id,
  ImageAsset,
  ImageFilters,
  NodeTransform,
  PageBackground,
  PageSize,
  PlakatDocument,
  PlakatElement,
  PresetId,
  Rect,
  ShapeElement,
  ShapeKind,
  SlotFill,
  SlotPatch,
  SlotSpec,
  TemplateSlot,
  TextElement,
} from '@plakat/schema';
import type { ClipboardData } from '../lib/clipboard.ts';
import type { AlignEdge, DistributeAxis } from '../lib/align.ts';
import type { ElementPatch } from '../lib/element-patch.ts';
import type { DocumentChange } from './changes.ts';
import type { SelectionSnapshot } from './history.ts';

export type { DocumentChange, SelectionSnapshot, ClipboardData, ElementPatch, AlignEdge, DistributeAxis };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Where the open document is persisted. */
export type PersistenceKind = 'project' | 'template';

/**
 * - idle: nothing to save (new unsaved doc without target, or just loaded)
 * - unsaved: local changes not yet saved (autosave pending)
 * - saving: request in flight
 * - saved: server has the current revision
 * - error: last save failed (autosave retries with backoff)
 * - conflict: server answered 409 version_conflict; autosave paused until resolveConflict()
 * - readonly: target cannot be written (built-in template)
 */
export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' | 'conflict' | 'readonly';

/** Side panels; free-form strings are allowed for panels added later. */
export type PanelId = 'templates' | 'text' | 'shapes' | 'uploads' | 'photos' | 'brand' | 'pages' | 'layers' | 'slots' | 'properties' | (string & {});

export type AddTextPreset = 'heading' | 'subheading' | 'body';

/** An existing registry asset, or a new asset record to add (deduplicated by src). */
export type AssetInput =
  | { assetId: Id }
  | (Pick<ImageAsset, 'src' | 'width' | 'height' | 'mimeType'> & Partial<Pick<ImageAsset, 'name'>> & { source?: AssetSource | null });

export interface EditorState {
  // --- document & history -------------------------------------------------
  document: PlakatDocument;
  /** Incremented on every document change (commit, undo, redo, load). */
  docRevision: number;
  /** Last change notification (see DocumentChange). null before the first load. */
  lastChange: DocumentChange | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  // --- persistence (written by api/persistence.ts) ---------------------------
  /** Server id of the open project/template, null for an unsaved local document. */
  projectId: string | null;
  projectKind: PersistenceKind;
  /** Server version of the last load/save (projects only). */
  version: number | null;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: string | null;
  /** docRevision the server is known to have. */
  savedRevision: number;

  // --- selection & modes -------------------------------------------------------
  /** Selected element ids, all on activePageId, in selection order. */
  selectedIds: Id[];
  activePageId: Id;
  hoveredId: Id | null;
  /** Text element being edited inline (textarea overlay), or null. */
  textEditingId: Id | null;
  /** Image element in crop mode, or null. */
  cropModeId: Id | null;

  // --- view ----------------------------------------------------------------------
  /** 1 = 100 %. Pan is owned by the canvas. */
  zoom: number;
  /** 'fit' re-fits when the viewport/page size changes; any explicit zoom sets 'manual'. */
  zoomMode: 'fit' | 'manual';
  /** Canvas viewport size in CSS px (reported by the canvas via setViewportSize). */
  viewportSize: { width: number; height: number } | null;

  // --- clipboard, brand, UI ------------------------------------------------------
  clipboard: (ClipboardData & { pasteCount: number }) | null;
  brandKits: BrandKit[];
  activeBrandKitId: Id | null;
  activePanel: PanelId | null;
  shortcutsHelpOpen: boolean;
  /** Last user-facing error from an action (e.g. a TemplateError message); UI may toast and clear it. */
  lastError: string | null;

  actions: EditorActions;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * Mutates the draft, OR returns a new document computed from `base` (e.g. a pure
 * @plakat/schema helper); the result is reconciled into the draft structurally.
 */
export type CommitRecipe = (draft: Draft<PlakatDocument>, base: PlakatDocument) => void | PlakatDocument;

export interface CommitOptions {
  /** Consecutive commits with the same key within `coalesceWindowMs` become ONE undo step. */
  coalesceKey?: string;
  coalesceWindowMs?: number;
  /** Merge into the previous undo step unconditionally (follow-up fixes like text auto-height). */
  merge?: boolean;
  /** Selection after the commit (default: current selection minus deleted ids). */
  select?: Id[];
  /** Active page after the commit (default: unchanged, or a neighbour if it was deleted). */
  activePageId?: Id;
  /** Ids to report in lastChange.ids even if their objects are unchanged (drag/transform end). */
  touched?: Id[];
}

export interface CommitResult {
  /** The document changed (a history entry was pushed or merged). */
  changed: boolean;
  document: PlakatDocument;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface OpenDocumentOptions {
  projectId?: string | null;
  projectKind?: PersistenceKind;
  version?: number | null;
  updatedAt?: string | null;
  /** Mark as read-only (e.g. built-in template). */
  readonly?: boolean;
}

export interface AddElementOptions {
  /** Target page (default: active page). */
  pageId?: Id;
  /** Select the new element (default true). */
  select?: boolean;
  /** Keep partial.x/y instead of centering on the page. */
  keepPosition?: boolean;
}

export interface ResizeDocumentOptions {
  /**
   * 'scale' (default): uniformly scale all content by min(newW/oldW, newH/oldH) and
   * center it (positions, sizes, font sizes, stroke widths, corner radii, dash, blur).
   * 'none': keep content geometry untouched (it may be clipped or leave empty space).
   */
  content?: 'scale' | 'none';
}

export interface EditorActions {
  // --- core ---------------------------------------------------------------
  /** THE way to change the document: records undo, updates selection, emits lastChange. */
  commit(label: string, recipe: CommitRecipe, options?: CommitOptions): CommitResult;
  undo(): boolean;
  redo(): boolean;
  /** Ends a coalescing run so the next commit starts a new undo step. */
  breakCoalescing(): void;
  clearHistory(): void;

  // --- document lifecycle (resets history, selection and modes) ------------------
  openDocument(doc: PlakatDocument, options?: OpenDocumentOptions): void;
  newDocument(size?: PresetId | PageSize, options?: { title?: string; kind?: 'design' | 'template' }): void;
  setTitle(title: string): void;
  /** Resize all pages (documents share one size). */
  resizeDocument(size: PresetId | PageSize, options?: ResizeDocumentOptions): void;

  // --- persistence bookkeeping (used by api/persistence.ts) ------------------------
  setPersistenceState(patch: Partial<Pick<EditorState, 'projectId' | 'projectKind' | 'version' | 'saveStatus' | 'saveError' | 'lastSavedAt' | 'savedRevision'>>): void;

  // --- selection ---------------------------------------------------------------------
  /**
   * Selects ids (expanding groupId groups unless `expandGroups: false`). `mode`:
   * replace (default) | add | toggle | remove. Switches activePageId to the page of
   * the first id. Exits text/crop modes for elements no longer selected.
   */
  select(ids: Id[], options?: { mode?: 'replace' | 'add' | 'toggle' | 'remove'; expandGroups?: boolean }): void;
  /** Selects all visible, unlocked elements of the active page. */
  selectAll(): void;
  selectNone(): void;
  setActivePage(pageId: Id): void;
  setHovered(id: Id | null): void;
  /** Escape: exit text editing, else exit crop mode, else clear the selection. */
  escape(): void;

  // --- modes ---------------------------------------------------------------------------
  startTextEditing(id: Id): void;
  stopTextEditing(): void;
  enterCropMode(id: Id): void;
  exitCropMode(): void;

  // --- view ----------------------------------------------------------------------------
  setZoom(zoom: number): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Fits the active page into the viewport (zoomMode 'fit'). */
  zoomToFit(): void;
  zoomTo100(): void;
  setViewportSize(size: { width: number; height: number }): void;

  // --- UI flags --------------------------------------------------------------------------
  setActivePanel(panel: PanelId | null): void;
  togglePanel(panel: PanelId): void;
  setShortcutsHelpOpen(open: boolean): void;
  toggleShortcutsHelp(): void;
  setError(message: string | null): void;

  // --- add elements (centered on the page unless keepPosition) ----------------------------
  addText(partial?: Partial<Omit<TextElement, 'id' | 'type'>> & { preset?: AddTextPreset }, options?: AddElementOptions): Id;
  addShape(shape: ShapeKind, partial?: Partial<Omit<ShapeElement, 'id' | 'type' | 'shape'>>, options?: AddElementOptions): Id;
  /** Adds an image element for an asset (new record or existing id). Fits 60 % of the short page side. */
  addImage(asset: AssetInput, partial?: Partial<Pick<PlakatElement, 'x' | 'y' | 'width' | 'height' | 'name'>>, options?: AddElementOptions): Id;
  /** Inserts foreign elements (+ their assets) via importElements; returns new ids. */
  insertElements(elements: readonly PlakatElement[], assets?: Readonly<Record<Id, Asset>>, options?: AddElementOptions & { offset?: { x: number; y: number } }): Id[];
  /** Registers an asset (dedupe by src) without placing it; returns its id. */
  addAsset(asset: AssetInput): Id;

  // --- edit elements -------------------------------------------------------------------------
  /** Partial update, sanitized/clamped to schema ranges. Fields that do not apply to the type are ignored. */
  updateElement(id: Id, patch: ElementPatch, options?: CommitOptions & { label?: string }): void;
  /** Same patch (or a per-element function) for several elements, one undo step. */
  updateElements(ids: Id[], patch: ElementPatch | ((el: PlakatElement) => ElementPatch | null), options?: CommitOptions & { label?: string }): void;
  /** Commits Konva Transformer/drag results via bakeTransform; always reports ids as touched. Skips locked elements and unrepresentable transforms. */
  commitTransforms(transforms: Record<Id, NodeTransform>, options?: { label?: string }): void;
  /** Moves elements by a delta (drag end with snapping applied by the canvas). */
  moveElements(ids: Id[], dx: number, dy: number, options?: CommitOptions & { label?: string }): void;
  /** Rotates each element about its own center to `rotation` degrees. */
  setRotation(ids: Id[], rotation: number, options?: CommitOptions): void;
  /** Deletes elements (default: selection). Locked elements are kept unless `force`. */
  deleteElements(ids?: Id[], options?: { force?: boolean }): void;
  /** Duplicates (default: selection) +16 px, above the topmost original; selects the copies. */
  duplicateElements(ids?: Id[]): Id[];
  rename(id: Id, name: string): void;
  setLocked(ids: Id[], locked: boolean): void;
  /** Lock if any is unlocked, else unlock (default: selection). */
  toggleLock(ids?: Id[]): void;
  setHidden(ids: Id[], hidden: boolean): void;
  toggleHidden(ids?: Id[]): void;

  // --- text & fonts ----------------------------------------------------------------------------
  /** Sets family, adapting weight/style to what the family offers. */
  setFontFamily(ids: Id[], family: string): void;
  toggleBold(ids?: Id[]): void;
  toggleItalic(ids?: Id[]): void;
  /** Typing in the inline editor: coalesced per element ("Edit text"). */
  setTextContent(id: Id, content: string): void;

  // --- images -------------------------------------------------------------------------------------
  /** Sets the crop (fitted into the image without distortion) and optionally the box. null = back to objectFit. */
  setCrop(id: Id, crop: CropRect | null, options?: { box?: Partial<Rect> }): void;
  /** Swaps the asset keeping framing (remapCrop) and box. */
  replaceImage(id: Id, asset: AssetInput): void;
  setFilters(ids: Id[], filters: Partial<ImageFilters>, options?: CommitOptions): void;
  resetFilters(ids?: Id[]): void;
  flip(ids: Id[], axis: 'x' | 'y'): void;

  // --- clipboard --------------------------------------------------------------------------------------
  /** Copies elements (default: selection) + assets into the internal clipboard; returns the data (null if nothing). */
  copy(ids?: Id[]): ClipboardData | null;
  cut(ids?: Id[]): ClipboardData | null;
  /** Pastes the internal clipboard (or `data`, e.g. parsed from the system clipboard) onto the active page. */
  paste(data?: ClipboardData, options?: { pageId?: Id }): Id[];

  // --- arrange ------------------------------------------------------------------------------------------
  bringForward(ids?: Id[]): void;
  sendBackward(ids?: Id[]): void;
  bringToFront(ids?: Id[]): void;
  sendToBack(ids?: Id[]): void;
  /** Moves an element to index `toIndex` of its page (layers panel drag). */
  moveElementToIndex(id: Id, toIndex: number): void;
  group(ids?: Id[]): Id | null;
  ungroup(ids?: Id[]): void;
  /** One unit -> relative to the page; several -> to the selection bounds. Locked units stay. */
  align(edge: AlignEdge, ids?: Id[]): void;
  /** Needs >= 3 units. */
  distribute(axis: DistributeAxis, ids?: Id[]): void;
  /** Coalesced per selection within 1 s ("Nudge"). Locked elements are skipped. */
  nudge(dx: number, dy: number, ids?: Id[]): void;

  // --- pages ---------------------------------------------------------------------------------------------------
  /** Adds a blank page after the active page (or at `index`); activates it. */
  addPage(options?: { index?: number; background?: Partial<PageBackground> }): Id;
  duplicatePage(pageId?: Id): Id | null;
  /** Keeps >= 1 page: returns false for the last page. */
  deletePage(pageId?: Id): boolean;
  movePage(pageId: Id, toIndex: number): void;
  renamePage(pageId: Id, name: string): void;
  setPageBackground(pageId: Id | undefined, background: { color?: Color | null; image?: AssetInput | null }): void;

  // --- templates ---------------------------------------------------------------------------------------------------
  convertToTemplate(category?: string | null): void;
  convertToDesign(): void;
  setTemplateCategory(category: string | null): void;
  /** Throws TemplateError on invalid specs (also sets lastError). */
  addSlot(spec: Id | SlotSpec): TemplateSlot;
  updateSlot(slotId: Id, patch: SlotPatch): void;
  setSlotTargets(slotId: Id, targets: Id[]): void;
  removeSlot(slotId: Id): void;
  moveSlot(slotId: Id, index: number): void;
  /** Fill-mode edit of a slot (templates only). Throws TemplateError on invalid fills. */
  fillSlot(slotId: Id, fill: SlotFill): void;

  // --- brand kits ------------------------------------------------------------------------------------------------------
  setBrandKits(kits: BrandKit[]): void;
  upsertBrandKit(kit: BrandKit): void;
  removeBrandKit(kitId: Id): void;
  setActiveBrandKit(kitId: Id | null): void;
  /** applyBrandKit() on the document (default: active kit, all pages). */
  applyBrandKit(kitId?: Id, options?: ApplyBrandKitOptions): void;
  /** Inserts a kit logo as an image element (asset merged via importElements). */
  insertBrandLogo(logoId: Id, kitId?: Id): Id | null;
  /** Writes a literal color: text fill, shape fill (or stroke for lines / property 'stroke'). Default: selection. */
  applyColor(color: Color, options?: { ids?: Id[]; property?: 'fill' | 'stroke' }): void;
  /** Applies the kit font of `role` to text elements (default: selection). */
  applyBrandFont(role: BrandFontRole, options?: { ids?: Id[]; kitId?: Id }): void;
}
