import {
  checkCanvasLimits,
  DEFAULT_CANVAS_LIMITS,
  EXPORT_SCALES,
  exportPixelSize,
  pdfPageLayout,
  type CanvasLimits,
  type ExportScaleId,
  type Id,
  type PlakatDocument,
} from '@plakat/schema';
import { encodeCanvas, setJpegDpi, setPngDpi } from './encode.ts';
import { CanvasLimitError } from './errors.ts';
import { exportBaseName, pageFileName } from './filename.ts';
import { Konva } from './konva.ts';
import { rasterizePage } from './rasterize.ts';
import { prepareResources } from './resources.ts';
import { PageScene } from './scene.ts';
import type { ExportData, RenderCanvas, RenderEnv, Resources } from './types.ts';
import { createZip } from './zip.ts';

export type ExportFormat = 'png' | 'jpg' | 'pdf';

/** Default JPEG quality (§5). */
export const DEFAULT_JPEG_QUALITY = 0.92;

export const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  zip: 'application/zip',
} as const;

/** A rendered page bitmap of exactly `width × height` device pixels. */
export interface RenderedPage {
  canvas: RenderCanvas;
  width: number;
  height: number;
  pixelRatio: number;
  /** Frees the bitmap memory (Konva.Util.releaseCanvas). */
  release(): void;
}

function clampQuality(q: number | undefined): number {
  if (q === undefined || !Number.isFinite(q)) return DEFAULT_JPEG_QUALITY;
  return Math.min(1, Math.max(0.5, q));
}

function limitsFor(env: RenderEnv | undefined, override?: CanvasLimits): CanvasLimits {
  return override ?? env?.canvasLimits?.() ?? DEFAULT_CANVAS_LIMITS;
}

/** Throws CanvasLimitError when `doc` at `scale` does not fit the canvas limits (§4). */
export function assertCanvasFits(doc: Pick<PlakatDocument, 'size'>, scale: number | ExportScaleId, limits: CanvasLimits = DEFAULT_CANVAS_LIMITS): void {
  const dims = exportPixelSize(doc.size, scale);
  const reason = checkCanvasLimits(dims, limits);
  if (reason) throw new CanvasLimitError(dims.width, dims.height, reason);
}

function stageContainer(env: RenderEnv | undefined): HTMLDivElement | undefined {
  if (env?.createStageContainer) return env.createStageContainer();
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') return document.createElement('div');
  return undefined;
}

/**
 * THE export path before encoding (§4): a fresh PageScene at pixelRatio = s on a detached
 * offscreen stage, rasterized with the same `rasterizePage` the editor uses. Synchronous:
 * `resources` must already satisfy the readiness barrier.
 */
export function renderPageWithResources(
  doc: PlakatDocument,
  pageId: Id,
  resources: Resources,
  scale: number | ExportScaleId,
  opts: { env?: RenderEnv; canvasLimits?: CanvasLimits } = {},
): RenderedPage {
  const dims = exportPixelSize(doc.size, scale);
  assertCanvasFits(doc, scale, limitsFor(opts.env, opts.canvasLimits));
  const scene = new PageScene({ doc, pageId, resources, pixelRatio: dims.pixelRatio });
  const container = stageContainer(opts.env);
  const stage = new Konva.Stage({ ...(container ? { container } : {}), width: 1, height: 1, listening: false } as ConstructorParameters<typeof Konva.Stage>[0]);
  const layer = new Konva.Layer({ listening: false });
  stage.add(layer);
  layer.add(scene.root);
  let canvas: RenderCanvas;
  try {
    canvas = rasterizePage(scene, scale);
  } finally {
    scene.destroy();
    stage.destroy();
  }
  return {
    canvas,
    width: dims.width,
    height: dims.height,
    pixelRatio: dims.pixelRatio,
    release: () => Konva.Util.releaseCanvas(canvas),
  };
}

export interface RenderPageOptions {
  scale: number | ExportScaleId;
  env: RenderEnv;
  /** Skip the readiness barrier and use these resources. */
  resources?: Resources;
  /** Render with fallback fonts instead of refusing (§3.1). Default false. */
  allowFallbackFonts?: boolean;
  canvasLimits?: CanvasLimits;
}

/** Readiness barrier + export path: the page as an un-encoded RGBA canvas. */
export async function renderPageCanvas(doc: PlakatDocument, pageId: Id, opts: RenderPageOptions): Promise<RenderedPage> {
  assertCanvasFits(doc, opts.scale, limitsFor(opts.env, opts.canvasLimits));
  const resources =
    opts.resources ?? (await prepareResources(doc, [pageId], opts.env, { allowFallbackFonts: opts.allowFallbackFonts ?? false }));
  return renderPageWithResources(doc, pageId, resources, opts.scale, { env: opts.env, canvasLimits: opts.canvasLimits });
}

/** A new canvas of the same size: white, with `src` drawn on top (JPG/PDF flattening, §5). */
export function flattenOntoWhite(src: RenderCanvas): RenderCanvas {
  const c = Konva.Util.createCanvasElement();
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0);
  return c;
}

function isPrintScale(scale: number): boolean {
  return scale === EXPORT_SCALES.print;
}

async function encodePage(rendered: RenderedPage, format: 'png' | 'jpg', env: RenderEnv, quality?: number): Promise<Uint8Array> {
  const print = isPrintScale(rendered.pixelRatio);
  if (format === 'png') {
    const bytes = await encodeCanvas(env, rendered.canvas, 'image/png');
    return print ? setPngDpi(bytes, 300) : bytes;
  }
  const flat = flattenOntoWhite(rendered.canvas);
  try {
    const bytes = await encodeCanvas(env, flat, 'image/jpeg', clampQuality(quality));
    return print ? setJpegDpi(bytes, 300) : bytes;
  } finally {
    Konva.Util.releaseCanvas(flat);
  }
}

function wrap(env: RenderEnv, bytes: Uint8Array, mimeType: string): ExportData {
  return env.wrapOutput ? env.wrapOutput(bytes, mimeType) : bytes;
}

export interface ExportPageOptions extends RenderPageOptions {
  format: 'png' | 'jpg';
  /** JPEG quality 0.5..1 (default 0.92). */
  quality?: number;
}

/** One page as an encoded PNG/JPG (Blob in browsers, Buffer under Node). */
export async function exportPage(doc: PlakatDocument, pageId: Id, opts: ExportPageOptions): Promise<ExportData> {
  const rendered = await renderPageCanvas(doc, pageId, opts);
  try {
    const bytes = await encodePage(rendered, opts.format, opts.env, opts.quality);
    return wrap(opts.env, bytes, MIME_TYPES[opts.format]);
  } finally {
    rendered.release();
  }
}

export interface ExportDocumentOptions {
  format: ExportFormat;
  /** Default: 'print' for PDF, '1x' otherwise. */
  scale?: number | ExportScaleId;
  /** Pages to export, in this order (default: all pages). */
  pageIds?: readonly Id[];
  /** JPEG quality 0.5..1 (default 0.92). */
  quality?: number;
  env: RenderEnv;
  allowFallbackFonts?: boolean;
  canvasLimits?: CanvasLimits;
  /** Called after each page is rendered. */
  onProgress?: (done: number, total: number) => void;
  /** ZIP entry timestamps (default now). */
  date?: Date;
}

export interface ExportResult {
  filename: string;
  mimeType: string;
  data: ExportData;
}

const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r));

/**
 * Export a document (§5): one PNG/JPG for a single page, a STORE ZIP of
 * `<slug>-NN.<ext>` for several pages (P-11), or one raster PDF (P-10). Pages are
 * rendered sequentially and released before the next one starts.
 */
export async function exportDocument(doc: PlakatDocument, opts: ExportDocumentOptions): Promise<ExportResult> {
  const pageIds = opts.pageIds ? [...opts.pageIds] : doc.pages.map((p) => p.id);
  if (pageIds.length === 0) throw new Error('No pages to export');
  const pageNumber = new Map(doc.pages.map((p, i) => [p.id, i + 1] as const));
  for (const id of pageIds) if (!pageNumber.has(id)) throw new Error(`Page "${id}" is not in the document`);
  const scale = opts.scale ?? (opts.format === 'pdf' ? 'print' : '1x');
  const limits = limitsFor(opts.env, opts.canvasLimits);
  assertCanvasFits(doc, scale, limits);
  const resources = await prepareResources(doc, pageIds, opts.env, { allowFallbackFonts: opts.allowFallbackFonts ?? false });
  const base = exportBaseName(doc.meta.title);
  const total = pageIds.length;

  if (opts.format === 'pdf') {
    const layout = pdfPageLayout(doc.size);
    // Loaded on demand: keeps jsPDF out of the editor's initial bundle.
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({
      unit: 'pt',
      format: [layout.width, layout.height],
      orientation: layout.orientation,
      userUnit: layout.userUnit,
    });
    pdf.setProperties({ title: doc.meta.title, creator: 'Plakat' });
    for (let i = 0; i < total; i++) {
      if (i > 0) {
        pdf.addPage([layout.width, layout.height], layout.orientation);
        await yieldToEventLoop();
      }
      const rendered = renderPageWithResources(doc, pageIds[i]!, resources, scale, { env: opts.env, canvasLimits: limits });
      try {
        const flat = flattenOntoWhite(rendered.canvas);
        try {
          const png = await encodeCanvas(opts.env, flat, 'image/png');
          pdf.addImage(png, 'PNG', 0, 0, layout.width, layout.height, undefined, 'FAST');
        } finally {
          Konva.Util.releaseCanvas(flat);
        }
      } finally {
        rendered.release();
      }
      opts.onProgress?.(i + 1, total);
    }
    const bytes = new Uint8Array(pdf.output('arraybuffer'));
    return { filename: `${base}.pdf`, mimeType: MIME_TYPES.pdf, data: wrap(opts.env, bytes, MIME_TYPES.pdf) };
  }

  const format = opts.format;
  const files: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < total; i++) {
    if (i > 0) await yieldToEventLoop();
    const id = pageIds[i]!;
    const rendered = renderPageWithResources(doc, id, resources, scale, { env: opts.env, canvasLimits: limits });
    try {
      const bytes = await encodePage(rendered, format, opts.env, opts.quality);
      files.push({ name: pageFileName(base, pageNumber.get(id)!, doc.pages.length, format), data: bytes });
    } finally {
      rendered.release();
    }
    opts.onProgress?.(i + 1, total);
  }
  if (files.length === 1) {
    const filename = doc.pages.length > 1 ? files[0]!.name : `${base}.${format}`;
    return { filename, mimeType: MIME_TYPES[format], data: wrap(opts.env, files[0]!.data, MIME_TYPES[format]) };
  }
  const zip = createZip(files.map((f) => ({ ...f, ...(opts.date ? { date: opts.date } : {}) })));
  return { filename: `${base}.zip`, mimeType: MIME_TYPES.zip, data: wrap(opts.env, zip, MIME_TYPES.zip) };
}
