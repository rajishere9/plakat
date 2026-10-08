/**
 * WorkspaceController: the imperative editor stage (render-export-pipeline.md §2, P-3, P-12).
 *
 *   Konva.Stage            zoom = stage.scale(), pan = stage.position()
 *   ├─ underlay layer      page backdrops (white / checkerboard + shadow); never exported
 *   ├─ content layer       one page frame (Group at the page offset) per page, each holding
 *   │                      exactly one PageScene.root from @plakat/renderer
 *   └─ chrome layer        Transformer, selection/hover outlines, snap guides, marquee,
 *                          page labels, crop-mode overlay; never exported
 *
 * Content nodes are only mutated live during drag/transform (and hidden while their text
 * is edited inline or their image is cropped); every gesture ends with a store commit and
 * `scene.update(doc, { dirty })`, so nodes are document-exact at rest.
 */
import {
  Konva,
  PageScene,
  applyElement,
  createElementNode,
  createEmptyResources,
  createPageFrame,
  editorPixelRatio,
  FontLoadError,
  invalidateTextMeasurements,
  encodeCanvasDefault,
  getElementIdFromNode,
  getPageIdFromNode,
  mountPageScene,
  prepareResources,
  rasterizePage,
  type RenderEnv,
  type Resources,
} from '@plakat/renderer';
import {
  collectFonts,
  fontLoadRequests,
  referencedAssetIds,
  type FontLoadRequest,
  type ExportScaleId,
  type Id,
  type NodeTransform,
  type Page,
  type PlakatDocument,
  type PlakatElement,
  type TextElement,
} from '@plakat/schema';
import type { Group } from 'konva/lib/Group';
import type { Layer } from 'konva/lib/Layer';
import type { Node as KonvaNode } from 'konva/lib/Node';
import type { Stage } from 'konva/lib/Stage';
import type { Image as KonvaImage } from 'konva/lib/shapes/Image';
import type { Rect as KonvaRect } from 'konva/lib/shapes/Rect';
import type { Text as KonvaText } from 'konva/lib/shapes/Text';
import type { Box, Transformer } from 'konva/lib/shapes/Transformer';
import { computeResizeSnap, computeSnap, edgesForAnchor, getSnapTargets, type Guide, type SpacingGuide } from '../lib/snapping.ts';
import { clampZoom } from '../lib/zoom.ts';
import { selectTransformerConfig } from '../store/selectors.ts';
import type { EditorStore } from '../store/editor-store.ts';
import type { DocumentChange, EditorState } from '../store/types.ts';
import {
  beginCropSession,
  constrainCropDrag,
  constrainCropResize,
  cropFromRect,
  cropRectChanged,
  type CropAnchor,
  type CropSession,
} from './crop-math.ts';
import { cleanNodeTransform, elementsInMarquee, movedSelectionBounds, pastThreshold, rotationSnapConfig, snapAngle } from './interaction.ts';
import {
  clampPan,
  computePageLayout,
  nearestPage,
  pageAtViewportCenter,
  pageAtWorldPoint,
  pageToScreen,
  pageVisibility,
  panToShowPage,
  rectFromPoints,
  roundPan,
  screenRectToPage,
  pageRectToScreen,
  screenToPage,
  screenToWorld,
  snapThresholdForZoom,
  wheelDeltaPx,
  wheelZoomFactor,
  zoomAround,
  type PageFrameLayout,
  type PageLayout,
  type Point,
  type ViewState,
  type Viewport,
} from './viewport.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkspaceStatus {
  /** The readiness barrier (or a later resource load) is still running. */
  loading: boolean;
  /** Font variants that failed to load (rendered with a fallback font). */
  missingFonts: string[];
  /** Assets that failed to load (drawn as a checkerboard placeholder). */
  missingAssets: Id[];
}

export interface ContextMenuRequest {
  /** Viewport (client) coordinates of the click. */
  clientX: number;
  clientY: number;
  /** Container-relative coordinates. */
  x: number;
  y: number;
  /** Element under the pointer (selected by the right click), or null. */
  elementId: Id | null;
  /** Page under the pointer, or null. */
  pageId: Id | null;
}

export interface WorkspaceControllerOptions {
  /** Element the Konva stage is mounted into; it should fill the workspace. */
  host: HTMLDivElement;
  store: EditorStore;
  env: RenderEnv;
  /** Override devicePixelRatio (tests). */
  devicePixelRatio?: () => number;
  onStatus?: (status: WorkspaceStatus) => void;
  onContextMenu?: (request: ContextMenuRequest) => void;
}

/** Normalized pointer input (DOM PointerEvent fields the controller uses). */
export interface PointerInput {
  /** Container-relative CSS px. */
  x: number;
  y: number;
  button?: number;
  pointerId?: number;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/** Geometry the inline text editor needs. */
export interface TextEditGeometry {
  element: TextElement;
  pageId: Id;
  /** Container-relative screen position of the page origin. */
  pageOrigin: Point;
  zoom: number;
}

export interface TextMeasure {
  /** Konva text node width (≥ element width), page px. */
  width: number;
  /** Measured text height, page px. */
  height: number;
  /** Text node y inside the element box (vertical alignment), page px. */
  offsetY: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const ACCENT = '#6d4aff';
const LOCKED_COLOR = '#9aa0ad';
const GUIDE_COLOR = '#ff2d87';
const LABEL_COLOR = '#5f6470';
const CHROME_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const RATIO_DEBOUNCE_MS = 150;
const FOLLOW_PAGE_DEBOUNCE_MS = 200;
/** Poll interval for fonts that missed the readiness barrier (besides document.fonts 'loadingdone'). */
const FONT_RETRY_MS = 3000;
/** Text fields that change a text's laid-out height (refit after any edit of these). */
const TEXT_LAYOUT_KEYS = ['content', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'width', 'textTransform'] as const;

/** Same label format the renderer uses in FontLoadError.missing. */
function fontVariantLabel(r: Pick<FontLoadRequest, 'family' | 'weight' | 'style'>): string {
  return `"${r.family}" ${r.style} ${r.weight}`;
}
const CORNERS: CropAnchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

interface PageEntry {
  pageId: Id;
  scene: PageScene;
  frame: Group;
  detach: () => void;
  backdrop: KonvaRect;
  label: KonvaText;
}

type Gesture =
  | { kind: 'pan'; pointerId: number; start: Point; startPan: Point }
  | { kind: 'press'; pointerId: number; start: Point; id: Id; wasSelected: boolean; shift: boolean }
  | {
      kind: 'drag';
      pointerId: number;
      start: Point;
      pageId: Id;
      ids: Id[];
      elements: PlakatElement[];
      others: ReturnType<typeof getSnapTargets>;
      dx: number;
      dy: number;
      /** Last pointer position (screen px): the drop page is the page under it. */
      last: Point;
    }
  | { kind: 'inert'; pointerId: number }
  | {
      kind: 'marquee';
      pointerId: number;
      start: Point;
      pageId: Id | null;
      additive: boolean;
      moved: boolean;
      ids: Id[];
      /** Started on a locked element: a click without movement selects it. */
      lockedHit?: Id;
    };

interface TransformGesture {
  anchor: string | null;
  ids: Id[];
  /** Single text resized by a side anchor: width-only, re-wrapped live. */
  textSide: { id: Id; element: TextElement; width: number } | null;
}

interface CropUi {
  id: Id;
  session: CropSession;
  group: Group;
  rect: KonvaRect;
  clip: Group;
  transformer: Transformer;
  startRect: { x: number; y: number; width: number; height: number };
  cancelled: boolean;
}

/** Text elements added, or whose layout fields changed, in a commit. */
function textLayoutChanges(prev: PlakatDocument, next: PlakatDocument, change: DocumentChange): Id[] {
  if (change.ids.length === 0) return [];
  const want = new Set(change.ids);
  const before = new Map<Id, PlakatElement>();
  for (const p of prev.pages) for (const e of p.elements) if (want.has(e.id)) before.set(e.id, e);
  const out: Id[] = [];
  for (const p of next.pages) {
    for (const e of p.elements) {
      if (!want.has(e.id) || e.type !== 'text') continue;
      const old = before.get(e.id);
      if (!old || old.type !== 'text' || TEXT_LAYOUT_KEYS.some((k) => old[k] !== e[k])) out.push(e.id);
    }
  }
  return out;
}

function isDescendantOf(node: KonvaNode | null, ancestor: KonvaNode | null | undefined): boolean {
  if (!ancestor) return false;
  let n: KonvaNode | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.getParent();
  }
  return false;
}

function sameNodes(a: readonly KonvaNode[], b: readonly KonvaNode[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

let checkerboard: HTMLCanvasElement | null = null;
function checkerboardPattern(): HTMLCanvasElement | null {
  if (checkerboard) return checkerboard;
  try {
    const c = Konva.Util.createCanvasElement();
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#e3e5ea';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 8);
    checkerboard = c;
    return c;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class WorkspaceController {
  readonly stage: Stage;
  readonly underlayLayer: Layer;
  readonly contentLayer: Layer;
  readonly chromeLayer: Layer;
  readonly transformer: Transformer;

  private readonly host: HTMLDivElement;
  private readonly store: EditorStore;
  private readonly env: RenderEnv;
  private readonly getDpr: () => number;
  private readonly onStatus?: (status: WorkspaceStatus) => void;
  private readonly onContextMenuRequest?: (request: ContextMenuRequest) => void;

  private readonly pages = new Map<Id, PageEntry>();
  private readonly outlines: Group;
  private readonly guides: Group;
  private readonly labels: Group;
  private readonly marquee: KonvaRect;
  private readonly dropTarget: KonvaRect;
  private pendingCaret: { id: Id; x: number; y: number } | null = null;
  private fontRetry: { busy: boolean; dispose: () => void } | null = null;

  private resources: Resources = createEmptyResources();
  private doc: PlakatDocument;
  private generation = 0;
  private built = false;
  private readonly pending = new Set<Promise<unknown>>();
  private view: ViewState = { zoom: 1, panX: 0, panY: 0 };
  private viewport: Viewport | null = null;
  private layout: PageLayout = { pages: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, stride: 0 };
  private dpr: number;

  private gesture: Gesture | null = null;
  private transforming: TransformGesture | null = null;
  private crop: CropUi | null = null;
  private modeHidden = new Set<Id>();
  private zoomAnchor: Point | null = null;
  private selfActivePage = false;
  private spaceDown = false;
  private shiftDown = false;
  private hoverFrame = 0;
  private hoverPoint: Point | null = null;
  private ratioTimer: ReturnType<typeof setTimeout> | null = null;
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly viewListeners = new Set<() => void>();
  private readonly disposers: (() => void)[] = [];
  private indexDoc: PlakatDocument | null = null;
  private readonly index = new Map<Id, { element: PlakatElement; page: Page }>();

  constructor(opts: WorkspaceControllerOptions) {
    this.host = opts.host;
    this.store = opts.store;
    this.env = opts.env;
    this.getDpr = opts.devicePixelRatio ?? (() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
    this.dpr = this.getDpr();
    this.onStatus = opts.onStatus;
    this.onContextMenuRequest = opts.onContextMenu;
    this.doc = this.store.getState().document;
    this.view = { zoom: clampZoom(this.store.getState().zoom), panX: 0, panY: 0 };

    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.stage = new Konva.Stage({ container: this.host, width, height });
    this.underlayLayer = new Konva.Layer({ listening: false, name: 'plakat-underlay' });
    this.contentLayer = new Konva.Layer({ name: 'plakat-content' });
    this.chromeLayer = new Konva.Layer({ name: 'plakat-chrome' });
    this.stage.add(this.underlayLayer, this.contentLayer, this.chromeLayer);

    this.labels = new Konva.Group({ name: 'plakat-page-labels' });
    this.outlines = new Konva.Group({ name: 'plakat-outlines', listening: false });
    this.guides = new Konva.Group({ name: 'plakat-guides', listening: false });
    this.marquee = new Konva.Rect({
      name: 'plakat-marquee',
      visible: false,
      listening: false,
      fill: 'rgba(109, 74, 255, 0.08)',
      stroke: ACCENT,
      strokeWidth: 1,
      strokeScaleEnabled: false,
    });
    this.dropTarget = new Konva.Rect({
      name: 'plakat-drop-target',
      visible: false,
      listening: false,
      stroke: ACCENT,
      strokeWidth: 2,
      strokeScaleEnabled: false,
      dash: [6, 4],
    });
    this.transformer = new Konva.Transformer({
      name: 'plakat-transformer',
      flipEnabled: false,
      rotateEnabled: true,
      ignoreStroke: true,
      padding: 0,
      borderStroke: ACCENT,
      borderStrokeWidth: 1.5,
      anchorStroke: ACCENT,
      anchorFill: '#ffffff',
      anchorStrokeWidth: 1.5,
      anchorSize: 10,
      anchorCornerRadius: 5,
      rotateAnchorOffset: 28,
      shiftBehavior: 'default',
      ...rotationSnapConfig(false),
      boundBoxFunc: (oldBox: Box, newBox: Box) => this.boundBox(oldBox, newBox),
    });
    this.chromeLayer.add(this.labels, this.outlines, this.guides, this.marquee, this.dropTarget, this.transformer);
    this.transformer.on('transformstart', () => this.onTransformStart());
    this.transformer.on('transform', () => this.onTransform());
    this.transformer.on('transformend', () => this.onTransformEnd());

    this.host.style.touchAction = 'none';
    this.host.style.userSelect = 'none';
    this.attachDomListeners();
    this.disposers.push(this.store.subscribe((s, p) => this.onStore(s, p)));

    this.measure();
    this.handleFull(this.doc);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Resolves after the readiness barrier (and every later resource load) finished and the content was drawn. */
  async ready(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
      if (this.destroyed) return;
      if (this.ratioTimer) this.applyPixelRatio();
      this.contentLayer.draw();
      this.chromeLayer.draw();
      await Promise.resolve();
      if (this.pending.size === 0 && this.built) return;
    }
  }

  /** The editor's own PageScene for a page. */
  getScene(pageId: Id): PageScene | undefined {
    return this.pages.get(pageId)?.scene;
  }

  /**
   * PNG bytes of the editor's OWN PageScene through `rasterizePage` (§6.2): equal to
   * `exportPage(doc, pageId, { scale })` before encoding, whatever the zoom and pan.
   */
  async snapshotPage(pageId: Id, scale: number | ExportScaleId): Promise<Uint8Array> {
    await this.ready();
    const entry = this.pages.get(pageId);
    if (!entry) throw new Error(`Page "${pageId}" is not shown in the workspace`);
    const canvas = rasterizePage(entry.scene, scale);
    try {
      return await encodeCanvasDefault(canvas, 'image/png');
    } finally {
      Konva.Util.releaseCanvas(canvas);
    }
  }

  getView(): ViewState {
    return { ...this.view };
  }

  getLayout(): PageLayout {
    return this.layout;
  }

  getResources(): Resources {
    return this.resources;
  }

  /** Current status (loading / missing fonts and assets). */
  getStatus(): WorkspaceStatus {
    return {
      loading: !this.built || this.pending.size > 0,
      missingFonts: [...this.resources.missingFonts],
      missingAssets: [...this.resources.missingAssets],
    };
  }

  /** Sets the pan (screen px); clamped so content stays reachable unless `clamp: false`. */
  setPan(panX: number, panY: number, opts: { clamp?: boolean } = {}): void {
    this.applyView({ zoom: this.view.zoom, panX, panY }, opts.clamp ?? true);
  }

  /** Pans by a screen delta. */
  panBy(dx: number, dy: number): void {
    this.applyView({ zoom: this.view.zoom, panX: this.view.panX + dx, panY: this.view.panY + dy });
    this.scheduleFollowActivePage();
  }

  /** Scrolls so the page is shown (centered when it fits). */
  scrollToPage(pageId: Id): void {
    const frame = this.layout.pages.find((f) => f.pageId === pageId);
    if (!frame || !this.viewport) return;
    this.applyView({ zoom: this.view.zoom, ...panToShowPage(frame, this.view.zoom, this.viewport) });
  }

  /** Zooms keeping `anchor` (screen px, default: viewport center) fixed. Goes through the store. */
  zoomAt(zoom: number, anchor?: Point): void {
    this.zoomAnchor = anchor ?? null;
    try {
      this.store.getState().actions.setZoom(zoom);
    } finally {
      this.zoomAnchor = null;
    }
  }

  /** Screen (container px) → page point under it (null when not over a page unless `nearest`). */
  screenToPagePoint(p: Point, opts: { nearest?: boolean } = {}): { pageId: Id; x: number; y: number } | null {
    const world = screenToWorld(this.view, p);
    const frame = pageAtWorldPoint(this.layout, world) ?? (opts.nearest ? nearestPage(this.layout, world) : null);
    if (!frame) return null;
    const local = screenToPage(this.view, frame, p);
    return { pageId: frame.pageId, x: local.x, y: local.y };
  }

  /** Page point → screen (container px). */
  pageToScreenPoint(pageId: Id, p: Point): Point | null {
    const frame = this.layout.pages.find((f) => f.pageId === pageId);
    return frame ? pageToScreen(this.view, frame, p) : null;
  }

  /** Subscribe to view/geometry changes (zoom, pan, layout, document updates). */
  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  /** Geometry for the inline text editor (null when the element is not a shown text). */
  getTextEditGeometry(id: Id): TextEditGeometry | null {
    const hit = this.lookup(id);
    if (!hit || hit.element.type !== 'text') return null;
    const origin = this.pageToScreenPoint(hit.page.id, { x: 0, y: 0 });
    if (!origin) return null;
    return { element: hit.element, pageId: hit.page.id, pageOrigin: origin, zoom: this.view.zoom };
  }

  /**
   * Measures a text element exactly like the renderer lays it out (a throwaway node built by
   * the renderer's own createElementNode).
   */
  measureText(element: TextElement): TextMeasure {
    const group = createElementNode(element, { assets: this.doc.assets, resources: this.resources, pixelRatio: 1 });
    try {
      const text = group.getChildren()[1] as KonvaText | undefined;
      if (!text) return { width: element.width, height: element.fontSize * element.lineHeight, offsetY: 0 };
      return { width: text.width(), height: text.height(), offsetY: text.y() };
    } finally {
      group.destroy();
    }
  }

  /**
   * Grows a text element's box to its measured text height (merged into the previous undo
   * step). Returns true when it changed.
   */
  autoGrowText(id: Id): boolean {
    return this.growTextsToFit([id]).length > 0;
  }

  /**
   * Grows every listed text whose measured height exceeds its box (never shrinks: vertical
   * alignment relies on extra height), in ONE commit merged into the previous undo step.
   * Returns the ids that changed.
   */
  growTextsToFit(ids: Iterable<Id>): Id[] {
    if (this.destroyed) return [];
    const heights = new Map<Id, number>();
    for (const id of new Set(ids)) {
      const hit = this.lookup(id);
      if (!hit || hit.element.type !== 'text' || hit.element.locked) continue;
      const m = this.measureText(hit.element);
      if (m.height > hit.element.height + 0.5) heights.set(id, Math.ceil(m.height * 100) / 100);
    }
    if (heights.size === 0) return [];
    const changed = [...heights.keys()];
    this.store.getState().actions.updateElements(changed, (el) => ({ height: heights.get(el.id)! }), { merge: true, label: 'Fit text' });
    return changed;
  }

  /**
   * Automatic refit (after an edit, a late font, a rebuilt text): only while the last
   * document change is a user commit. After undo/redo/load it would push a new history
   * entry (dropping the redo stack) or dirty a freshly opened document.
   */
  private refitAfterEdit(ids: Id[]): void {
    if (this.store.getState().lastChange?.source !== 'commit') return;
    this.growTextsToFit(ids);
  }

  /** The double-click point (container px) that opened inline editing of `id`, consumed once. */
  takeTextEditCaret(id: Id): Point | null {
    const c = this.pendingCaret;
    this.pendingCaret = null;
    return c && c.id === id ? { x: c.x, y: c.y } : null;
  }

  /**
   * Fonts that missed the readiness barrier (timeout / slow network): retries them, and when
   * they become available rebuilds the affected text nodes with the real metrics, refits their
   * boxes and clears them from `missingFonts`, so the canvas matches what export will draw.
   * Called automatically (document.fonts 'loadingdone' + polling); public for tests.
   */
  async retryMissingFonts(): Promise<string[]> {
    const w = this.fontRetry;
    if (this.destroyed || (w && w.busy)) return [];
    const missing = new Set(this.resources.missingFonts);
    if (missing.size === 0) {
      this.stopFontWatch();
      return [];
    }
    const doc = this.doc;
    const resources = this.resources;
    const requests = fontLoadRequests(doc).filter((r) => missing.has(fontVariantLabel(r)));
    if (requests.length === 0) return [];
    const families = new Set(requests.map((r) => r.family));
    if (w) w.busy = true;
    let still: string[] = [];
    try {
      await this.env.loadFonts(
        collectFonts({ pages: doc.pages, fonts: doc.fonts }).filter((f) => families.has(f.family)),
        requests,
      );
    } catch (err) {
      still = err instanceof FontLoadError ? err.missing : requests.map(fontVariantLabel);
    } finally {
      if (w) w.busy = false;
    }
    if (this.destroyed || resources !== this.resources) return [];
    const recovered = requests.filter((r) => !still.includes(fontVariantLabel(r)));
    if (recovered.length === 0) return [];
    const labels = new Set(recovered.map(fontVariantLabel));
    for (let i = resources.missingFonts.length - 1; i >= 0; i--) if (labels.has(resources.missingFonts[i]!)) resources.missingFonts.splice(i, 1);
    invalidateTextMeasurements();
    const latest = this.doc;
    const ids: Id[] = [];
    for (const page of latest.pages) {
      const rebuild = page.elements
        .filter((e): e is TextElement => e.type === 'text' && labels.has(fontVariantLabel({ family: e.fontFamily, weight: e.fontWeight, style: e.fontStyle })))
        .map((e) => e.id);
      if (rebuild.length === 0) continue;
      ids.push(...rebuild);
      this.pages.get(page.id)?.scene.update(latest, { rebuildText: rebuild, resources });
    }
    this.syncModeVisibility();
    this.contentLayer.batchDraw();
    this.refitAfterEdit(ids);
    this.renderChrome();
    this.emitView();
    this.emitStatus();
    if (resources.missingFonts.length === 0) this.stopFontWatch();
    return [...labels];
  }

  private watchMissingFonts(): void {
    if (this.fontRetry || this.destroyed || this.resources.missingFonts.length === 0) return;
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    const retry = () => void this.retryMissingFonts();
    fonts?.addEventListener?.('loadingdone', retry);
    const timer = setInterval(retry, FONT_RETRY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.fontRetry = {
      busy: false,
      dispose: () => {
        fonts?.removeEventListener?.('loadingdone', retry);
        clearInterval(timer);
      },
    };
  }

  private stopFontWatch(): void {
    this.fontRetry?.dispose();
    this.fontRetry = null;
  }

  /**
   * Escape while cropping: discards the crop edit and leaves crop mode. Returns false when not
   * in crop mode (the default Escape handling then applies).
   */
  cancelCrop(): boolean {
    if (!this.crop) return false;
    this.crop.cancelled = true;
    this.store.getState().actions.exitCropMode();
    return true;
  }

  /** Enter: applies the crop / starts editing the single selected text. Returns true when handled. */
  handleEnter(): boolean {
    const s = this.store.getState();
    if (s.cropModeId) {
      s.actions.exitCropMode();
      return true;
    }
    if (s.textEditingId || s.selectedIds.length !== 1) return false;
    const hit = this.lookup(s.selectedIds[0]!);
    if (!hit || hit.element.locked) return false;
    if (hit.element.type === 'text') {
      s.actions.startTextEditing(hit.element.id);
      return true;
    }
    return false;
  }

  /** Whether snapping is applied to drags/resizes (hold Alt to bypass per gesture). */
  snapping = true;

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    if (this.ratioTimer) clearTimeout(this.ratioTimer);
    if (this.followTimer) clearTimeout(this.followTimer);
    if (this.hoverFrame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.hoverFrame);
    for (const d of this.disposers.splice(0)) d();
    this.stopFontWatch();
    this.destroyCrop(false);
    for (const entry of this.pages.values()) this.destroyEntry(entry);
    this.pages.clear();
    this.viewListeners.clear();
    this.stage.destroy();
  }

  // =========================================================================
  // Store → canvas
  // =========================================================================

  private onStore(state: EditorState, prev: EditorState): void {
    if (this.destroyed) return;
    if (state.lastChange && state.lastChange !== prev.lastChange) this.handleChange(state.lastChange, state.document);
    if (state.zoom !== this.view.zoom || (state.zoomMode === 'fit' && prev.zoomMode !== 'fit')) this.handleZoom(state);
    if (state.cropModeId !== prev.cropModeId) this.handleCropMode(state.cropModeId, prev.cropModeId);
    if (state.textEditingId !== prev.textEditingId) {
      if (!state.textEditingId) this.pendingCaret = null;
      this.syncModeVisibility();
    }
    if (state.activePageId !== prev.activePageId) this.handleActivePage(state.activePageId);
    if (
      state.lastChange !== prev.lastChange ||
      state.selectedIds !== prev.selectedIds ||
      state.hoveredId !== prev.hoveredId ||
      state.activePageId !== prev.activePageId ||
      state.textEditingId !== prev.textEditingId ||
      state.cropModeId !== prev.cropModeId
    ) {
      this.renderChrome();
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const tracked: Promise<unknown> = p.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(tracked);
    void tracked.then(() => {
      this.pending.delete(tracked);
      this.emitStatus();
    });
    return p;
  }

  /** New document: rebuild everything behind the readiness barrier. */
  private handleFull(doc: PlakatDocument): void {
    const gen = ++this.generation;
    this.gesture = null;
    this.transforming = null;
    this.transformer.nodes([]);
    this.destroyCrop(false);
    this.modeHidden.clear();
    for (const entry of this.pages.values()) this.destroyEntry(entry);
    this.pages.clear();
    this.built = false;
    this.doc = doc;
    this.stopFontWatch();
    this.resources = createEmptyResources();
    this.relayout();
    this.drawBackdropsOnly(doc);
    this.emitStatus();
    const resources = this.resources;
    this.track(
      (async () => {
        try {
          await prepareResources(doc, undefined, this.env, { allowFallbackFonts: true, allowMissingAssets: true, into: resources });
        } catch (err) {
          console.warn('[plakat] workspace resources failed to load:', err);
        }
        if (gen !== this.generation || this.destroyed) return;
        const latest = this.store.getState().document;
        this.doc = latest;
        this.buildScenes(latest);
        this.built = true;
        if (latest !== doc) {
          // The document changed while loading: load what the newer version needs.
          this.ensureResources(
            latest.pages.map((p) => p.id),
            latest.pages.flatMap((p) => p.elements.filter((e) => e.type === 'text').map((e) => e.id)),
          );
        }
        this.fitOnLoad();
      })(),
    );
  }

  private fitOnLoad(): void {
    const s = this.store.getState();
    if (s.zoomMode === 'fit') {
      s.actions.zoomToFit();
      this.relayout();
      this.centerOnPage(this.store.getState().activePageId);
    } else {
      this.relayout();
      this.scrollToPage(s.activePageId);
    }
    this.renderChrome();
    this.emitView();
  }

  private buildScenes(doc: PlakatDocument): void {
    for (const page of doc.pages) this.createEntry(doc, page.id);
    this.relayout();
    this.syncModeVisibility();
    this.contentLayer.batchDraw();
    this.renderChrome();
    this.emitView();
  }

  private createEntry(doc: PlakatDocument, pageId: Id): PageEntry {
    const scene = new PageScene({ doc, pageId, resources: this.resources, pixelRatio: editorPixelRatio(this.view.zoom, this.dpr) });
    const frame = createPageFrame({ x: 0, y: 0, pageId });
    this.contentLayer.add(frame);
    const detach = mountPageScene(frame, scene);
    const backdrop = new Konva.Rect({ name: 'plakat-page-backdrop', listening: false, shadowColor: 'rgba(15, 23, 42, 0.18)', shadowForStrokeEnabled: false });
    this.underlayLayer.add(backdrop);
    const label = new Konva.Text({ name: 'page-label', fontFamily: CHROME_FONT, fontSize: 12, fill: LABEL_COLOR, listening: true });
    label.setAttr('plakatPageId', pageId);
    this.labels.add(label);
    const entry: PageEntry = { pageId, scene, frame, detach, backdrop, label };
    this.pages.set(pageId, entry);
    return entry;
  }

  private destroyEntry(entry: PageEntry): void {
    entry.detach();
    entry.scene.destroy();
    entry.frame.destroy();
    entry.backdrop.destroy();
    entry.label.destroy();
  }

  /** Before the barrier resolves: show blank page backdrops so the layout is visible. */
  private drawBackdropsOnly(doc: PlakatDocument): void {
    this.underlayLayer.destroyChildren();
    for (const frame of this.layout.pages) {
      const page = doc.pages.find((p) => p.id === frame.pageId);
      const rect = new Konva.Rect({ listening: false, shadowColor: 'rgba(15, 23, 42, 0.18)' });
      this.styleBackdrop(rect, frame, page);
      this.underlayLayer.add(rect);
    }
    this.underlayLayer.batchDraw();
  }

  private handleChange(change: DocumentChange, doc: PlakatDocument): void {
    if (change.full) {
      this.handleFull(doc);
      return;
    }
    if (!this.built) {
      this.doc = doc; // the pending build uses the newest document
      return;
    }
    // Leave crop mode cleanly if its element changed underneath (undo/redo/panel edit).
    if (this.crop && change.ids.includes(this.crop.id)) {
      const id = this.crop.id;
      this.destroyCrop(false);
      if (this.store.getState().cropModeId === id) queueMicrotask(() => this.store.getState().cropModeId === id && this.enterCrop(id));
    }
    for (const pageId of change.pagesRemoved) {
      const entry = this.pages.get(pageId);
      if (entry) {
        this.destroyEntry(entry);
        this.pages.delete(pageId);
      }
    }
    const prevDoc = this.doc;
    this.doc = doc;
    if (change.source === 'commit') {
      // Text boxes follow their text (schema D-9): any edit of a layout field (panel, brand
      // font, bold toggle, paste, …) refits the height, merged into the same undo step.
      const refit = textLayoutChanges(prevDoc, doc, change);
      if (refit.length > 0) queueMicrotask(() => this.refitAfterEdit(refit));
    }
    const touchedPages = new Set(change.pages);
    if (change.ids.length > 0) {
      const ids = new Set(change.ids);
      for (const page of doc.pages) if (page.elements.some((e) => ids.has(e.id))) touchedPages.add(page.id);
    }
    const created: Id[] = [];
    for (const page of doc.pages) {
      const entry = this.pages.get(page.id);
      if (!entry) {
        this.createEntry(doc, page.id);
        created.push(page.id);
      } else if (change.sizeChanged || touchedPages.has(page.id)) {
        entry.scene.update(doc, { dirty: change.ids });
      }
    }
    this.relayout();
    this.syncModeVisibility();
    this.contentLayer.batchDraw();

    const resourcePages = new Set<Id>([...created]);
    if (change.rebuildText.length > 0 || change.assetsChanged) for (const id of touchedPages) resourcePages.add(id);
    for (const id of touchedPages) if (this.pageNeedsImages(doc, id)) resourcePages.add(id);
    const pageIds = doc.pages.map((p) => p.id).filter((id) => resourcePages.has(id));
    const textIds = [...change.rebuildText, ...doc.pages.filter((p) => created.includes(p.id)).flatMap((p) => p.elements.filter((e) => e.type === 'text').map((e) => e.id))];
    if (pageIds.length > 0) this.ensureResources(pageIds, textIds);
    this.emitView();
  }

  private pageNeedsImages(doc: PlakatDocument, pageId: Id): boolean {
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return false;
    for (const assetId of referencedAssetIds({ pages: [page] })) {
      if (!this.resources.images.has(assetId) && !this.resources.missingAssets.includes(assetId)) return true;
    }
    return false;
  }

  /**
   * Late resources (§3.1 "Late fonts"): runs the barrier for the pages, then rebuilds the
   * listed text nodes (fresh build after the fonts are ready) and re-applies image nodes
   * whose bitmap arrived.
   */
  private ensureResources(pageIds: Id[], textIds: Id[]): void {
    const gen = this.generation;
    const doc = this.doc;
    this.track(
      (async () => {
        try {
          await prepareResources(doc, pageIds, this.env, { allowFallbackFonts: true, allowMissingAssets: true, into: this.resources });
        } catch (err) {
          console.warn('[plakat] workspace resources failed to load:', err);
        }
        if (gen !== this.generation || this.destroyed) return;
        const latest = this.doc;
        const wanted = new Set(textIds);
        const refit: Id[] = [];
        for (const pageId of pageIds) {
          const entry = this.pages.get(pageId);
          const page = latest.pages.find((p) => p.id === pageId);
          if (!entry || !page) continue;
          const rebuild = page.elements.filter((e) => e.type === 'text' && wanted.has(e.id)).map((e) => e.id);
          entry.scene.update(latest, { rebuildText: rebuild, resources: this.resources });
          refit.push(...rebuild);
        }
        // Metrics may differ from the fallback measured before the face arrived.
        if (refit.length > 0) this.refitAfterEdit(refit);
        this.syncModeVisibility();
        this.contentLayer.batchDraw();
        this.renderChrome();
        this.emitView();
      })(),
    );
  }

  /** Hides the node of the text being edited / image being cropped; restores the others. */
  private syncModeVisibility(): void {
    const s = this.store.getState();
    const want = new Set<Id>();
    if (s.textEditingId) want.add(s.textEditingId);
    if (s.cropModeId && this.crop?.id === s.cropModeId) want.add(s.cropModeId);
    for (const id of this.modeHidden) {
      if (want.has(id)) continue;
      const entry = this.entryForElement(id);
      if (entry) entry.scene.update(this.doc, { dirty: [id] });
    }
    for (const id of want) this.getElementNode(id)?.visible(false);
    this.modeHidden = want;
    this.contentLayer.batchDraw();
  }

  private handleActivePage(pageId: Id): void {
    if (this.selfActivePage || !this.viewport) return;
    const frame = this.layout.pages.find((f) => f.pageId === pageId);
    if (frame && pageVisibility(this.view, frame, this.viewport) < 0.5) this.scrollToPage(pageId);
  }

  // =========================================================================
  // View: zoom, pan, layout
  // =========================================================================

  private layoutAt(zoom: number): PageLayout {
    return computePageLayout(
      this.doc.pages.map((p) => p.id),
      this.doc.size,
      zoom,
      this.dpr,
    );
  }

  private measure(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!(width > 0 && height > 0)) return;
    const changed = !this.viewport || this.viewport.width !== width || this.viewport.height !== height;
    this.viewport = { width, height };
    this.stage.size({ width, height });
    if (changed) this.store.getState().actions.setViewportSize({ width, height });
    if (this.store.getState().zoomMode === 'fit') {
      this.relayout();
      this.centerOnPage(this.store.getState().activePageId);
    } else {
      this.applyView(this.view);
    }
  }

  private handleZoom(state: EditorState): void {
    const zoom = clampZoom(state.zoom);
    if (!this.viewport) {
      this.view = { ...this.view, zoom };
      this.relayout();
      return;
    }
    if (state.zoomMode === 'fit' && !this.zoomAnchor) {
      this.view = { ...this.view, zoom };
      this.relayout();
      this.centerOnPage(state.activePageId);
    } else {
      const anchor = this.zoomAnchor ?? { x: this.viewport.width / 2, y: this.viewport.height / 2 };
      const next = zoomAround(this.view, (z) => this.layoutAt(z), anchor, zoom);
      this.view = { ...this.view, zoom };
      this.relayout();
      this.applyView(next);
    }
    this.scheduleRatioUpdate();
  }

  private centerOnPage(pageId: Id): void {
    if (!this.viewport) return;
    const frame = this.layout.pages.find((f) => f.pageId === pageId) ?? this.layout.pages[0];
    if (!frame) {
      this.applyView(this.view);
      return;
    }
    this.applyView({ zoom: this.view.zoom, ...panToShowPage(frame, this.view.zoom, this.viewport) });
  }

  private applyView(view: ViewState, clamp = true): void {
    let v = view;
    if (clamp && this.viewport && this.layout.pages.length > 0) v = clampPan(v, this.layout.bounds, this.viewport);
    v = roundPan(v, this.dpr);
    this.view = v;
    this.stage.scale({ x: v.zoom, y: v.zoom });
    this.stage.position({ x: v.panX, y: v.panY });
    this.styleChromeForZoom();
    this.stage.batchDraw();
    this.emitView();
  }

  /** Positions frames, backdrops and labels for the current zoom (screen-constant gaps). */
  private relayout(): void {
    this.layout = this.layoutAt(this.view.zoom);
    for (const frame of this.layout.pages) {
      const entry = this.pages.get(frame.pageId);
      if (!entry) continue;
      entry.frame.position({ x: frame.x, y: frame.y });
      const page = this.doc.pages.find((p) => p.id === frame.pageId);
      this.styleBackdrop(entry.backdrop, frame, page);
      if (entry.backdrop.zIndex() !== frame.index) entry.backdrop.zIndex(Math.min(frame.index, this.underlayLayer.getChildren().length - 1));
      const name = page?.name ? ` – ${page.name}` : '';
      entry.label.text(`Page ${frame.index + 1}${name}`);
    }
    // Leftover pre-build backdrops.
    if (this.built) {
      for (const child of [...this.underlayLayer.getChildren()]) {
        if (![...this.pages.values()].some((e) => e.backdrop === child)) child.destroy();
      }
    }
    this.styleChromeForZoom();
    this.underlayLayer.batchDraw();
    this.contentLayer.batchDraw();
  }

  private styleBackdrop(rect: KonvaRect, frame: PageFrameLayout, page: Page | undefined): void {
    const z = this.view.zoom || 1;
    const transparent = !page || page.background.color === null;
    const pattern = transparent ? checkerboardPattern() : null;
    rect.setAttrs({
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      fill: pattern ? undefined : '#ffffff',
      fillPatternImage: (pattern ?? undefined) as unknown as HTMLImageElement | undefined,
      fillPatternScaleX: 1 / z,
      fillPatternScaleY: 1 / z,
      shadowBlur: 10 / z,
      shadowOffsetX: 0,
      shadowOffsetY: 2 / z,
    });
  }

  /** Screen-constant chrome sizes (labels) after a zoom change. */
  private styleChromeForZoom(): void {
    const z = this.view.zoom || 1;
    const active = this.store.getState().activePageId;
    for (const frame of this.layout.pages) {
      const entry = this.pages.get(frame.pageId);
      if (!entry) continue;
      entry.label.setAttrs({
        x: frame.x,
        y: frame.y - 20 / z,
        scaleX: 1 / z,
        scaleY: 1 / z,
        fill: frame.pageId === active ? ACCENT : LABEL_COLOR,
        fontStyle: frame.pageId === active ? 'bold' : 'normal',
      });
    }
  }

  private scheduleRatioUpdate(): void {
    if (this.ratioTimer) clearTimeout(this.ratioTimer);
    this.ratioTimer = setTimeout(() => this.applyPixelRatio(), RATIO_DEBOUNCE_MS);
  }

  /** P-7 / §2.2: scenes render at zoom × devicePixelRatio (debounced after zoom changes). */
  private applyPixelRatio(): void {
    if (this.ratioTimer) clearTimeout(this.ratioTimer);
    this.ratioTimer = null;
    if (this.destroyed) return;
    const r = editorPixelRatio(this.view.zoom, this.dpr);
    for (const entry of this.pages.values()) entry.scene.setPixelRatio(r);
    this.syncModeVisibility();
    this.contentLayer.batchDraw();
    this.emitView();
  }

  private handleDprChange(): void {
    const dpr = this.getDpr();
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    for (const layer of [this.underlayLayer, this.contentLayer, this.chromeLayer]) layer.getCanvas().setPixelRatio(dpr);
    this.relayout();
    this.applyView(this.view);
    this.applyPixelRatio();
  }

  private scheduleFollowActivePage(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => this.followActivePage(), FOLLOW_PAGE_DEBOUNCE_MS);
  }

  /** After scrolling: the page in the middle of the viewport becomes active (when nothing is selected). */
  private followActivePage(): void {
    this.followTimer = null;
    if (this.destroyed || !this.viewport) return;
    const s = this.store.getState();
    if (s.selectedIds.length > 0 || s.textEditingId || s.cropModeId || this.gesture) return;
    const frame = pageAtViewportCenter(this.view, this.layout, this.viewport);
    if (!frame || frame.pageId === s.activePageId) return;
    this.selfActivePage = true;
    try {
      s.actions.setActivePage(frame.pageId);
    } finally {
      this.selfActivePage = false;
    }
  }

  private emitView(): void {
    for (const l of this.viewListeners) l();
  }

  private emitStatus(): void {
    if (this.built && this.resources.missingFonts.length > 0) this.watchMissingFonts();
    this.onStatus?.(this.getStatus());
  }

  // =========================================================================
  // Lookup
  // =========================================================================

  private lookup(id: Id): { element: PlakatElement; page: Page } | undefined {
    if (this.indexDoc !== this.doc) {
      this.index.clear();
      for (const page of this.doc.pages) for (const element of page.elements) this.index.set(element.id, { element, page });
      this.indexDoc = this.doc;
    }
    return this.index.get(id);
  }

  private entryForElement(id: Id): PageEntry | undefined {
    const hit = this.lookup(id);
    return hit ? this.pages.get(hit.page.id) : undefined;
  }

  /** The content node of an element (Konva.Group, id = element id). */
  getElementNode(id: Id): Group | undefined {
    return this.entryForElement(id)?.scene.getElementNode(id);
  }

  private frameOf(pageId: Id): PageFrameLayout | undefined {
    return this.layout.pages.find((f) => f.pageId === pageId);
  }

  // =========================================================================
  // Chrome
  // =========================================================================

  private renderChrome(): void {
    if (this.destroyed) return;
    const s = this.store.getState();
    const g = this.gesture;

    // Transformer: unlocked, visible selected nodes (P-3: it lives on the chrome layer).
    const nodes: Group[] = [];
    if (!s.cropModeId && !s.textEditingId && this.built) {
      for (const id of s.selectedIds) {
        const hit = this.lookup(id);
        if (!hit || hit.element.locked || hit.element.hidden) continue;
        const node = this.getElementNode(id);
        if (node) nodes.push(node);
      }
    }
    if (!this.transforming) {
      if (!sameNodes(this.transformer.nodes(), nodes)) this.transformer.nodes(nodes);
      if (nodes.length > 0) {
        const cfg = selectTransformerConfig(s);
        this.transformer.setAttrs({ keepRatio: cfg.keepRatio, enabledAnchors: cfg.enabledAnchors, flipEnabled: false });
      }
      this.transformer.visible(nodes.length > 0);
    }

    // Outlines (selection, locked, hover, marquee preview), in world units.
    this.outlines.destroyChildren();
    if (!this.transforming && !s.cropModeId) {
      const selected = new Set(s.selectedIds);
      const drag = g?.kind === 'drag' ? g : null;
      for (const id of s.selectedIds) {
        const hit = this.lookup(id);
        if (!hit) continue;
        if (id === s.textEditingId) {
          // Editing box (the textarea has no border of its own).
          this.addOutline(hit.element, hit.page.id, ACCENT, 0, 0, true, 1);
          continue;
        }
        const moving = drag && drag.ids.includes(id);
        this.addOutline(hit.element, hit.page.id, hit.element.locked ? LOCKED_COLOR : ACCENT, moving ? drag.dx : 0, moving ? drag.dy : 0, hit.element.locked);
      }
      if (g?.kind === 'marquee' && g.pageId) {
        for (const id of g.ids) {
          const hit = this.lookup(id);
          if (hit && !selected.has(id)) this.addOutline(hit.element, hit.page.id, ACCENT, 0, 0, false, 1);
        }
      }
      if (!g && s.hoveredId && !selected.has(s.hoveredId)) {
        const hit = this.lookup(s.hoveredId);
        if (hit && !hit.element.hidden) this.addOutline(hit.element, hit.page.id, ACCENT, 0, 0, false, 1.5);
      }
    }
    this.styleChromeForZoom();
    this.chromeLayer.batchDraw();
  }

  private addOutline(el: PlakatElement, pageId: Id, color: string, dx: number, dy: number, dashed: boolean, width = 1.5): void {
    const frame = this.frameOf(pageId);
    if (!frame) return;
    this.outlines.add(
      new Konva.Rect({
        x: frame.x + el.x + dx,
        y: frame.y + el.y + dy,
        width: el.width,
        height: el.height,
        rotation: el.rotation,
        stroke: color,
        strokeWidth: width,
        strokeScaleEnabled: false,
        dash: dashed ? [4, 3] : undefined,
        listening: false,
      }),
    );
  }

  private drawGuides(pageId: Id | null, guides: readonly Guide[], spacing: readonly SpacingGuide[] = []): void {
    this.guides.destroyChildren();
    const frame = pageId ? this.frameOf(pageId) : undefined;
    if (frame) {
      for (const gd of guides) {
        const points =
          gd.axis === 'x'
            ? [frame.x + gd.position, frame.y + gd.start, frame.x + gd.position, frame.y + gd.end]
            : [frame.x + gd.start, frame.y + gd.position, frame.x + gd.end, frame.y + gd.position];
        this.guides.add(
          new Konva.Line({
            points,
            stroke: GUIDE_COLOR,
            strokeWidth: 1,
            strokeScaleEnabled: false,
            dash: gd.kind === 'page-center' || gd.kind === 'element-center' ? [4, 3] : undefined,
            listening: false,
          }),
        );
      }
      for (const sp of spacing) {
        for (const seg of sp.segments) {
          const points =
            sp.axis === 'x'
              ? [frame.x + seg.from, frame.y + seg.at, frame.x + seg.to, frame.y + seg.at]
              : [frame.x + seg.at, frame.y + seg.from, frame.x + seg.at, frame.y + seg.to];
          this.guides.add(new Konva.Line({ points, stroke: GUIDE_COLOR, strokeWidth: 1, strokeScaleEnabled: false, listening: false }));
        }
      }
    }
    this.chromeLayer.batchDraw();
  }

  // =========================================================================
  // Hit testing
  // =========================================================================

  private hitTest(
    p: Point,
  ):
    | { kind: 'transformer' }
    | { kind: 'crop' }
    | { kind: 'label'; pageId: Id }
    | { kind: 'element'; id: Id; pageId: Id }
    | { kind: 'page'; pageId: Id }
    | { kind: 'empty'; pageId: null } {
    this.ensureHitGraphs();
    const shape = this.stage.getIntersection(p);
    if (shape) {
      if (isDescendantOf(shape, this.transformer)) return { kind: 'transformer' };
      if (this.crop && (isDescendantOf(shape, this.crop.group) || isDescendantOf(shape, this.crop.transformer))) return { kind: 'crop' };
      if (shape.hasName('page-label')) {
        const pageId = shape.getAttr('plakatPageId') as Id | undefined;
        if (pageId) return { kind: 'label', pageId };
      }
      const id = getElementIdFromNode(shape);
      const pageId = getPageIdFromNode(shape);
      if (id && pageId) return { kind: 'element', id, pageId };
      if (pageId) return { kind: 'page', pageId };
    }
    const frame = pageAtWorldPoint(this.layout, screenToWorld(this.view, p));
    return frame ? { kind: 'page', pageId: frame.pageId } : { kind: 'empty', pageId: null };
  }

  /**
   * Konva redraws (scene + hit graph) on the next animation frame after batchDraw(); a hit
   * test in between (pointer event right after a store update or a pan) would read a stale
   * hit canvas. Redraw the hit graph synchronously when a draw is pending.
   */
  private ensureHitGraphs(): void {
    for (const layer of [this.contentLayer, this.chromeLayer]) {
      if ((layer as unknown as { _waitingForDraw?: boolean })._waitingForDraw) layer.drawHit();
    }
  }

  /** Element id under a screen point (hidden elements are never hit), or null. */
  elementAt(p: Point): Id | null {
    const hit = this.hitTest(p);
    return hit.kind === 'element' ? hit.id : null;
  }

  // =========================================================================
  // Pointer gestures (public for tests; DOM listeners call these)
  // =========================================================================

  pointerDown(e: PointerInput): boolean {
    if (this.destroyed || !this.built) return false;
    const p = { x: e.x, y: e.y };
    const pointerId = e.pointerId ?? 1;
    const button = e.button ?? 0;
    const s = this.store.getState();
    const a = s.actions;
    if (button === 1 || (button === 0 && this.spaceDown)) {
      this.gesture = { kind: 'pan', pointerId, start: p, startPan: { x: this.view.panX, y: this.view.panY } };
      this.setCursor('grabbing');
      return true;
    }
    const hit = this.hitTest(p);
    if (button === 2) {
      if (hit.kind === 'element' && !s.selectedIds.includes(hit.id)) a.select([hit.id]);
      return false;
    }
    if (button !== 0) return false;
    if (hit.kind === 'transformer' || hit.kind === 'crop') return false; // Konva handles these
    if (s.cropModeId) {
      a.exitCropMode(); // applies the crop
      return false;
    }
    if (hit.kind === 'label') {
      a.setActivePage(hit.pageId);
      return false;
    }
    if (hit.kind === 'element' && !e.shiftKey && this.startsMarquee(hit.id)) {
      // A locked element (typically a full-page background) never blocks rubber-band selection.
      this.gesture = { kind: 'marquee', pointerId, start: p, pageId: hit.pageId, additive: false, moved: false, ids: [], lockedHit: hit.id };
      if (s.hoveredId) a.setHovered(null);
      return true;
    }
    if (hit.kind === 'element') {
      const wasSelected = s.selectedIds.includes(hit.id);
      if (e.shiftKey) a.select([hit.id], { mode: 'toggle' });
      else if (!wasSelected) a.select([hit.id]);
      if (!this.store.getState().selectedIds.includes(hit.id)) return false;
      this.gesture = { kind: 'press', pointerId, start: p, id: hit.id, wasSelected, shift: !!e.shiftKey };
      if (s.hoveredId) a.setHovered(null);
      return true;
    }
    this.gesture = { kind: 'marquee', pointerId, start: p, pageId: hit.pageId, additive: !!e.shiftKey, moved: false, ids: [] };
    return true;
  }

  /**
   * A press on a locked element starts a marquee instead of an inert press, unless it is
   * part of a selection that has something draggable.
   */
  private startsMarquee(id: Id): boolean {
    const el = this.lookup(id)?.element;
    if (!el?.locked) return false;
    const s = this.store.getState();
    if (!s.selectedIds.includes(id)) return true;
    return !s.selectedIds.some((sid) => {
      const other = this.lookup(sid)?.element;
      return !!other && !other.locked && !other.hidden;
    });
  }

  pointerMove(e: PointerInput): void {
    if (this.destroyed) return;
    const p = { x: e.x, y: e.y };
    const g = this.gesture;
    if (!g) {
      this.scheduleHover(p);
      return;
    }
    if (g.pointerId !== (e.pointerId ?? 1)) return;
    switch (g.kind) {
      case 'pan':
        this.applyView({ zoom: this.view.zoom, panX: g.startPan.x + p.x - g.start.x, panY: g.startPan.y + p.y - g.start.y });
        return;
      case 'press':
        if (!pastThreshold(g.start, p)) return;
        this.startDrag(g);
        this.pointerMove(e);
        return;
      case 'drag':
        this.updateDrag(g, p, !!e.altKey || !this.snapping);
        return;
      case 'marquee':
        if (!g.moved && !pastThreshold(g.start, p)) return;
        g.moved = true;
        this.updateMarquee(g, p);
        return;
      case 'inert':
        return;
    }
  }

  pointerUp(e: PointerInput): void {
    const g = this.gesture;
    if (!g || g.pointerId !== (e.pointerId ?? 1)) return;
    this.gesture = null;
    const s = this.store.getState();
    const a = s.actions;
    switch (g.kind) {
      case 'pan':
        this.setCursor(this.spaceDown ? 'grab' : '');
        this.scheduleFollowActivePage();
        break;
      case 'press':
        // A click (no drag) inside a multi-selection narrows it to the clicked element (or its group).
        if (!g.shift && g.wasSelected && s.selectedIds.length > 1) a.select([g.id]);
        break;
      case 'drag':
        this.endDrag(g);
        break;
      case 'marquee':
        this.marquee.visible(false);
        if (!g.moved && g.lockedHit) {
          a.select([g.lockedHit]);
        } else if (!g.moved) {
          if (g.pageId && g.pageId !== s.activePageId) a.setActivePage(g.pageId);
          else if (!g.additive) a.selectNone();
        } else if (g.ids.length > 0) {
          a.select(g.ids, { mode: g.additive ? 'add' : 'replace' });
        } else if (!g.additive) {
          if (g.pageId && g.pageId !== s.activePageId) a.setActivePage(g.pageId);
          else a.selectNone();
        }
        break;
      case 'inert':
        break;
    }
    this.renderChrome();
  }

  /** Aborts the current gesture (pointercancel, blur): live node changes are reverted. */
  cancelGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (g?.kind === 'drag') {
      this.dropTarget.visible(false);
      const entry = this.pages.get(g.pageId);
      entry?.scene.update(this.doc, { dirty: g.ids });
      this.drawGuides(null, []);
    }
    this.marquee.visible(false);
    this.setCursor('');
    this.renderChrome();
  }

  doubleClick(e: PointerInput): void {
    if (this.destroyed || !this.built) return;
    const hit = this.hitTest({ x: e.x, y: e.y });
    if (hit.kind === 'crop') {
      this.store.getState().actions.exitCropMode();
      return;
    }
    if (hit.kind !== 'element') return;
    const el = this.lookup(hit.id)?.element;
    if (!el || el.locked) return;
    const a = this.store.getState().actions;
    if (el.type === 'text') {
      this.pendingCaret = { id: el.id, x: e.x, y: e.y };
      a.startTextEditing(el.id);
      if (this.store.getState().textEditingId !== el.id) this.pendingCaret = null;
    } else if (el.type === 'image') a.enterCropMode(el.id);
  }

  contextMenu(e: PointerInput & { clientX: number; clientY: number }): void {
    const hit = this.hitTest({ x: e.x, y: e.y });
    const s = this.store.getState();
    let elementId: Id | null = null;
    if (hit.kind === 'element') {
      elementId = hit.id;
      if (!s.selectedIds.includes(hit.id)) s.actions.select([hit.id]);
    }
    const pageId = hit.kind === 'element' || hit.kind === 'page' || hit.kind === 'label' ? hit.pageId : null;
    this.onContextMenuRequest?.({ clientX: e.clientX, clientY: e.clientY, x: e.x, y: e.y, elementId, pageId });
  }

  wheel(e: { x: number; y: number; deltaX: number; deltaY: number; deltaMode?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): void {
    if (this.destroyed || !this.viewport) return;
    const mode = e.deltaMode ?? 0;
    if (e.ctrlKey || e.metaKey) {
      const dy = wheelDeltaPx(e.deltaY, mode, this.viewport.height);
      const next = clampZoom(this.view.zoom * wheelZoomFactor(dy));
      if (Math.abs(next - this.view.zoom) < 1e-9) return;
      this.zoomAt(next, { x: e.x, y: e.y });
      return;
    }
    let dx = wheelDeltaPx(e.deltaX, mode, this.viewport.width);
    let dy = wheelDeltaPx(e.deltaY, mode, this.viewport.height);
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    this.panBy(-dx, -dy);
  }

  private scheduleHover(p: Point): void {
    this.hoverPoint = p;
    if (this.hoverFrame) return;
    const run = () => {
      this.hoverFrame = 0;
      const pt = this.hoverPoint;
      if (!pt || this.destroyed || this.gesture || !this.built) return;
      const hit = this.hitTest(pt);
      const s = this.store.getState();
      const id = hit.kind === 'element' ? hit.id : null;
      if (id !== s.hoveredId) s.actions.setHovered(id);
      if (this.spaceDown) this.setCursor('grab');
      else if (hit.kind === 'element') this.setCursor(this.lookup(hit.id)?.element.locked ? '' : 'move');
      else if (hit.kind === 'label') this.setCursor('pointer');
      else this.setCursor('');
    };
    if (typeof requestAnimationFrame === 'function') this.hoverFrame = requestAnimationFrame(run) as unknown as number;
    else run();
  }

  private setCursor(cursor: string): void {
    this.host.style.cursor = cursor;
  }

  private startDrag(g: Extract<Gesture, { kind: 'press' }>): void {
    const s = this.store.getState();
    const page = s.document.pages.find((p) => p.id === s.activePageId);
    const elements = page ? page.elements.filter((e) => s.selectedIds.includes(e.id) && !e.locked && !e.hidden) : [];
    if (!page || elements.length === 0) {
      this.gesture = { kind: 'inert', pointerId: g.pointerId };
      return;
    }
    const ids = elements.map((e) => e.id);
    this.gesture = {
      kind: 'drag',
      pointerId: g.pointerId,
      start: g.start,
      pageId: page.id,
      ids,
      elements,
      others: getSnapTargets(page, ids),
      dx: 0,
      dy: 0,
      last: g.start,
    };
    if (s.hoveredId) s.actions.setHovered(null);
  }

  private updateDrag(g: Extract<Gesture, { kind: 'drag' }>, p: Point, noSnap: boolean): void {
    const z = this.view.zoom;
    let dx = (p.x - g.start.x) / z;
    let dy = (p.y - g.start.y) / z;
    let guides: Guide[] = [];
    let spacing: SpacingGuide[] = [];
    if (!noSnap) {
      const bounds = movedSelectionBounds(g.elements, dx, dy);
      if (bounds) {
        const snap = computeSnap(bounds, { pageSize: this.doc.size, others: g.others }, snapThresholdForZoom(z));
        dx += snap.dx;
        dy += snap.dy;
        guides = snap.guides;
        spacing = snap.spacing;
      }
    }
    g.dx = dx;
    g.dy = dy;
    g.last = p;
    const drop = this.dropFrameFor(g);
    if (drop) this.dropTarget.setAttrs({ x: drop.x, y: drop.y, width: drop.width, height: drop.height, visible: true });
    else this.dropTarget.visible(false);
    const entry = this.pages.get(g.pageId);
    for (const el of g.elements) entry?.scene.getElementNode(el.id)?.position({ x: el.x + dx, y: el.y + dy });
    this.contentLayer.batchDraw();
    this.drawGuides(g.pageId, guides, spacing);
    this.renderChrome();
  }

  /** Page frame under the pointer when it differs from the dragged elements' page (else null). */
  private dropFrameFor(g: Extract<Gesture, { kind: 'drag' }>): PageFrameLayout | null {
    const frame = pageAtWorldPoint(this.layout, screenToWorld(this.view, g.last));
    return frame && frame.pageId !== g.pageId ? frame : null;
  }

  private endDrag(g: Extract<Gesture, { kind: 'drag' }>): void {
    this.drawGuides(null, []);
    this.dropTarget.visible(false);
    const drop = this.dropFrameFor(g);
    const src = this.frameOf(g.pageId);
    if (drop && src) {
      // Dropped over another page: the elements move there, keeping their screen position.
      const moved = this.store.getState().actions.moveElementsToPage(g.ids, drop.pageId, g.dx + src.x - drop.x, g.dy + src.y - drop.y);
      if (moved.length > 0) {
        this.pages.get(g.pageId)?.scene.update(this.doc, { dirty: g.ids });
        this.syncModeVisibility();
        return;
      }
    }
    // Always commits (a zero move still reports the ids as touched, which resets the nodes).
    this.store.getState().actions.moveElements(g.ids, g.dx, g.dy);
    this.pages.get(g.pageId)?.scene.update(this.doc, { dirty: g.ids });
    this.syncModeVisibility();
  }

  private updateMarquee(g: Extract<Gesture, { kind: 'marquee' }>, p: Point): void {
    const startWorld = screenToWorld(this.view, g.start);
    if (!g.pageId) g.pageId = nearestPage(this.layout, startWorld)?.pageId ?? null;
    const frame = g.pageId ? this.frameOf(g.pageId) : undefined;
    const rectWorld = rectFromPoints(startWorld, screenToWorld(this.view, p));
    this.marquee.setAttrs({ ...rectWorld, visible: true });
    if (frame) {
      const page = this.doc.pages.find((pg) => pg.id === frame.pageId);
      const local = { x: rectWorld.x - frame.x, y: rectWorld.y - frame.y, width: rectWorld.width, height: rectWorld.height };
      g.ids = page ? elementsInMarquee(page, local) : [];
    }
    this.renderChrome();
  }

  // =========================================================================
  // Transformer
  // =========================================================================

  private boundBox(oldBox: Box, newBox: Box): Box {
    if (newBox.width < 1 || newBox.height < 1) return oldBox;
    const anchor = this.transformer.getActiveAnchor();
    const t = this.transforming;
    if (!anchor || anchor === 'rotater' || !this.snapping) return newBox;
    const rot = (((newBox.rotation * 180) / Math.PI) % 360 + 360) % 360;
    if (Math.min(rot, 360 - rot) > 1e-3) {
      this.drawGuides(null, []);
      return newBox;
    }
    const s = this.store.getState();
    const page = s.document.pages.find((p) => p.id === s.activePageId);
    const frame = page ? this.frameOf(page.id) : undefined;
    if (!page || !frame) return newBox;
    const rect = screenRectToPage(this.view, frame, newBox);
    const isCorner = anchor.includes('-') && !anchor.includes('center') && !anchor.startsWith('middle');
    const res = computeResizeSnap(
      rect,
      edgesForAnchor(anchor),
      { pageSize: this.doc.size, others: getSnapTargets(page, t?.ids ?? s.selectedIds) },
      snapThresholdForZoom(this.view.zoom),
      { keepRatio: isCorner && this.transformer.keepRatio(), minSize: 1 },
    );
    this.drawGuides(page.id, res.guides);
    const out = pageRectToScreen(this.view, frame, res.rect);
    return { ...out, rotation: newBox.rotation };
  }

  private onTransformStart(): void {
    const s = this.store.getState();
    const anchor = this.transformer.getActiveAnchor();
    const ids = this.transformer.nodes().map((n) => n.id());
    let textSide: TransformGesture['textSide'] = null;
    if (ids.length === 1 && (anchor === 'middle-left' || anchor === 'middle-right')) {
      const el = this.lookup(ids[0]!)?.element;
      if (el?.type === 'text') textSide = { id: el.id, element: el, width: el.width };
    }
    this.transforming = { anchor, ids, textSide };
    if (s.hoveredId) s.actions.setHovered(null);
    this.renderChrome();
  }

  private onTransform(): void {
    const t = this.transforming;
    if (t?.textSide) {
      // Width-only text resize: re-wrap live through the renderer's own mapping.
      const node = this.getElementNode(t.textSide.id);
      const entry = this.entryForElement(t.textSide.id);
      if (node && entry) {
        t.textSide.width = Math.max(1, t.textSide.width * Math.abs(node.scaleX()));
        applyElement(
          node,
          { ...t.textSide.element, x: node.x(), y: node.y(), rotation: node.rotation(), width: t.textSide.width },
          { assets: this.doc.assets, resources: this.resources, pixelRatio: entry.scene.pixelRatio },
        );
      }
    }
    this.contentLayer.batchDraw();
  }

  private onTransformEnd(): void {
    const t = this.transforming;
    this.transforming = null;
    this.drawGuides(null, []);
    if (!t) return;
    const a = this.store.getState().actions;
    if (t.textSide) {
      const node = this.getElementNode(t.textSide.id);
      if (node) {
        a.updateElement(t.textSide.id, { x: node.x(), y: node.y(), width: t.textSide.width }, { label: 'Resize' });
        this.entryForElement(t.textSide.id)?.scene.update(this.doc, { dirty: [t.textSide.id] });
        this.autoGrowText(t.textSide.id);
      }
    } else {
      const transforms: Record<Id, NodeTransform> = {};
      for (const node of this.transformer.nodes()) {
        const id = node.id();
        const entry = this.entryForElement(id);
        if (!entry) continue;
        const frameRotation = node.getAbsoluteTransform(entry.frame).decompose().rotation;
        transforms[id] = cleanNodeTransform({ x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY() }, frameRotation, {
          rotateOnly: t.anchor === 'rotater',
        });
      }
      // The content group's tiny anisotropic scale (P-8) bends a snapped screen angle by up to
      // ~0.02°: re-snap a single rotated node to the angle the user snapped to.
      const only = t.ids.length === 1 ? transforms[t.ids[0]!] : undefined;
      if (only && t.anchor === 'rotater') {
        const step = this.shiftDown ? 15 : 90;
        const snapped = snapAngle(only.rotation, step);
        const d = Math.abs(((only.rotation - snapped + 540) % 360) - 180);
        if (d < 0.05) only.rotation = snapped;
      }
      a.commitTransforms(transforms);
      for (const id of Object.keys(transforms)) this.entryForElement(id)?.scene.update(this.doc, { dirty: [id] });
      if (t.ids.length === 1 && t.anchor !== 'rotater') this.autoGrowText(t.ids[0]!);
    }
    this.syncModeVisibility();
    this.renderChrome();
  }

  /** Shift held: rotation snaps every 15°. */
  setShiftKey(down: boolean): void {
    if (this.shiftDown === down) return;
    this.shiftDown = down;
    this.transformer.setAttrs(rotationSnapConfig(down));
  }

  /** Space held: drag pans. */
  setSpaceKey(down: boolean): void {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    if (!this.gesture || this.gesture.kind !== 'pan') this.setCursor(down ? 'grab' : '');
  }

  // =========================================================================
  // Crop mode
  // =========================================================================

  private handleCropMode(next: Id | null, prev: Id | null): void {
    if (prev && this.crop?.id === prev) this.destroyCrop(true);
    if (next) this.enterCrop(next);
    this.syncModeVisibility();
  }

  private enterCrop(id: Id): void {
    if (this.crop) this.destroyCrop(false);
    const hit = this.lookup(id);
    const el = hit?.element;
    const frame = hit ? this.frameOf(hit.page.id) : undefined;
    if (!el || el.type !== 'image' || !frame) return;
    const asset = Object.hasOwn(this.doc.assets, el.assetId) ? this.doc.assets[el.assetId] : undefined;
    const decoded = this.resources.images.get(el.assetId);
    if (!asset || !decoded) {
      queueMicrotask(() => this.store.getState().actions.exitCropMode());
      return;
    }
    const session = beginCropSession(el, asset);
    const ghostAttrs = (opacity: number) => ({
      image: decoded,
      x: session.flipX ? session.ghost.x + session.ghost.width : session.ghost.x,
      y: session.flipY ? session.ghost.y + session.ghost.height : session.ghost.y,
      width: session.ghost.width,
      height: session.ghost.height,
      scaleX: session.flipX ? -1 : 1,
      scaleY: session.flipY ? -1 : 1,
      opacity,
      listening: false,
    });
    const group = new Konva.Group({ name: 'plakat-crop', x: frame.x + el.x, y: frame.y + el.y, rotation: el.rotation });
    const ghost = new Konva.Image(ghostAttrs(0.35)) as KonvaImage;
    const ghostBorder = new Konva.Rect({
      ...session.ghost,
      stroke: '#ffffff',
      strokeWidth: 1,
      dash: [4, 4],
      strokeScaleEnabled: false,
      listening: false,
    });
    const clip = new Konva.Group({ listening: false, clipX: 0, clipY: 0, clipWidth: el.width, clipHeight: el.height });
    clip.add(new Konva.Image(ghostAttrs(1)) as KonvaImage);
    const rect = new Konva.Rect({
      name: 'plakat-crop-rect',
      ...session.rect,
      fill: 'rgba(0, 0, 0, 0.001)',
      stroke: ACCENT,
      strokeWidth: 2,
      strokeScaleEnabled: false,
      draggable: true,
    });
    group.add(ghost, ghostBorder, clip, rect);
    const transformer = new Konva.Transformer({
      name: 'plakat-crop-transformer',
      nodes: [rect],
      rotateEnabled: false,
      flipEnabled: false,
      keepRatio: true,
      shiftBehavior: 'none',
      enabledAnchors: CORNERS,
      ignoreStroke: true,
      borderEnabled: false,
      anchorStroke: ACCENT,
      anchorFill: '#ffffff',
      anchorSize: 12,
      anchorCornerRadius: 2,
    });
    this.chromeLayer.add(group, transformer);
    const ui: CropUi = { id, session, group, rect, clip, transformer, startRect: { ...session.rect }, cancelled: false };
    const sync = () => {
      clip.clip({ x: rect.x(), y: rect.y(), width: rect.width(), height: rect.height() });
      this.chromeLayer.batchDraw();
    };
    rect.on('dragmove', () => {
      const r = constrainCropDrag({ x: rect.x(), y: rect.y(), width: rect.width(), height: rect.height() }, session.ghost);
      rect.position({ x: r.x, y: r.y });
      sync();
    });
    rect.on('transformstart', () => {
      ui.startRect = { x: rect.x(), y: rect.y(), width: rect.width(), height: rect.height() };
    });
    rect.on('transform', () => {
      const proposed = { x: rect.x(), y: rect.y(), width: rect.width() * Math.abs(rect.scaleX()), height: rect.height() * Math.abs(rect.scaleY()) };
      const anchor = (transformer.getActiveAnchor() ?? 'bottom-right') as CropAnchor;
      const r = constrainCropResize(proposed, ui.startRect, session.ghost, session.aspect, anchor, 8 / (this.view.zoom || 1));
      rect.setAttrs({ ...r, scaleX: 1, scaleY: 1 });
      sync();
    });
    rect.on('dblclick dbltap', () => this.store.getState().actions.exitCropMode());
    this.crop = ui;
    this.transformer.nodes([]);
    this.syncModeVisibility();
    this.renderChrome();
  }

  /** Ends the crop UI; with `apply`, commits the crop (one undo step) unless cancelled/unchanged. */
  private destroyCrop(apply: boolean): void {
    const ui = this.crop;
    if (!ui) return;
    this.crop = null;
    const rect = { x: ui.rect.x(), y: ui.rect.y(), width: ui.rect.width(), height: ui.rect.height() };
    ui.transformer.destroy();
    ui.group.destroy();
    this.chromeLayer.batchDraw();
    if (apply && !ui.cancelled && cropRectChanged(rect, ui.session.rect)) {
      const crop = cropFromRect(rect, ui.session);
      const id = ui.id;
      queueMicrotask(() => {
        if (!this.destroyed) this.store.getState().actions.setCrop(id, crop);
      });
    }
  }

  /** The active crop session (tests / overlays). */
  getCropState(): { id: Id; rect: { x: number; y: number; width: number; height: number }; session: CropSession } | null {
    const ui = this.crop;
    if (!ui) return null;
    return { id: ui.id, rect: { x: ui.rect.x(), y: ui.rect.y(), width: ui.rect.width(), height: ui.rect.height() }, session: ui.session };
  }

  /** Programmatic crop-rect change (tests, keyboard): constrained like a drag/resize. */
  setCropRect(r: { x: number; y: number; width: number; height: number }): void {
    const ui = this.crop;
    if (!ui) return;
    const prev = { x: ui.rect.x(), y: ui.rect.y(), width: ui.rect.width(), height: ui.rect.height() };
    const sized =
      Math.abs(r.width - prev.width) > 1e-9 || Math.abs(r.height - prev.height) > 1e-9
        ? constrainCropResize(r, { ...prev, x: r.x + r.width - prev.width, y: r.y + r.height - prev.height }, ui.session.ghost, ui.session.aspect, 'bottom-right', 1)
        : r;
    const placed = constrainCropDrag({ ...sized, x: r.x, y: r.y }, ui.session.ghost);
    ui.rect.setAttrs(placed);
    ui.clip.clip(placed);
    this.chromeLayer.batchDraw();
  }

  // =========================================================================
  // DOM wiring
  // =========================================================================

  private pointFromEvent(e: { clientX: number; clientY: number }): Point {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private attachDomListeners(): void {
    const host = this.host;
    const input = (e: PointerEvent | MouseEvent): PointerInput => ({
      ...this.pointFromEvent(e),
      button: e.button,
      pointerId: 'pointerId' in e ? e.pointerId : 1,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
    });
    const onDown = (e: PointerEvent) => {
      if (this.pointerDown(input(e))) {
        try {
          host.setPointerCapture?.(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    };
    const onMove = (e: PointerEvent) => this.pointerMove(input(e));
    const onUp = (e: PointerEvent) => {
      this.pointerUp(input(e));
      try {
        if (host.hasPointerCapture?.(e.pointerId)) host.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onCancel = () => this.cancelGesture();
    const onLeave = () => {
      if (!this.gesture && this.store.getState().hoveredId) this.store.getState().actions.setHovered(null);
    };
    const onDbl = (e: MouseEvent) => this.doubleClick(input(e));
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      this.contextMenu({ ...input(e), clientX: e.clientX, clientY: e.clientY });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.wheel({ ...this.pointFromEvent(e), deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
    };
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onCancel);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('dblclick', onDbl);
    host.addEventListener('contextmenu', onContext);
    host.addEventListener('wheel', onWheel, { passive: false });
    this.disposers.push(() => {
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onCancel);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('dblclick', onDbl);
      host.removeEventListener('contextmenu', onContext);
      host.removeEventListener('wheel', onWheel);
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.measure());
      ro.observe(host);
      this.disposers.push(() => ro.disconnect());
    } else if (typeof window !== 'undefined') {
      const onResize = () => this.measure();
      window.addEventListener('resize', onResize);
      this.disposers.push(() => window.removeEventListener('resize', onResize));
    }

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      let mql: MediaQueryList | null = null;
      const watch = () => {
        mql?.removeEventListener?.('change', onDpr);
        mql = window.matchMedia(`(resolution: ${this.getDpr()}dppx)`);
        mql.addEventListener?.('change', onDpr);
      };
      const onDpr = () => {
        this.handleDprChange();
        watch();
      };
      watch();
      this.disposers.push(() => mql?.removeEventListener?.('change', onDpr));
    }
  }
}

export type { ViewState, PageLayout, PageFrameLayout, Point };
