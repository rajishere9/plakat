/**
 * Test-only helpers (Node): fixture fonts, generated fixture images, document builders
 * and pixel utilities. Not exported from the package.
 */
import { createNodeEnv, type NodeFontFile, type NodeRenderEnv } from './env-node.ts';
import { createCanvas } from 'canvas';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  DEFAULT_FILTERS,
  assertValidDocument,
  presetToPageSize,
  type ImageAsset,
  type ImageElement,
  type ImageFilters,
  type Page,
  type PageSize,
  type PlakatDocument,
  type PlakatElement,
  type PresetId,
  type ShapeElement,
  type TextElement,
} from '@plakat/schema';
import type { RenderCanvas } from './types.ts';

const fontPath = (name: string) => fileURLToPath(new URL(`../test-fixtures/fonts/${name}`, import.meta.url));

/** Family registered from the OFL fixture (PT Sans), never an OS font name. */
export const FIXTURE_FAMILY = 'Plakat Fixture Sans';
/** A family whose file is registered only on demand (late-font tests). */
export const LATE_FAMILY = 'Plakat Late Sans';

export const FIXTURE_FONTS: NodeFontFile[] = [
  { file: fontPath('PTSans-Regular.ttf'), family: FIXTURE_FAMILY, weight: 400, style: 'normal' },
  { file: fontPath('PTSans-Bold.ttf'), family: FIXTURE_FAMILY, weight: 700, style: 'normal' },
];
export const LATE_FONT: NodeFontFile = { file: fontPath('PTSans-Bold.ttf'), family: LATE_FAMILY, weight: 400, style: 'normal' };

export function createTestEnv(extra: NodeFontFile[] = []): NodeRenderEnv {
  return createNodeEnv({ fontFiles: [...FIXTURE_FONTS, ...extra] });
}

// ---------------------------------------------------------------------------
// Fixture images (generated with node-canvas → data URIs)
// ---------------------------------------------------------------------------

export function pngDataUri(width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): string {
  const c = createCanvas(width, height);
  draw(c.getContext('2d') as unknown as CanvasRenderingContext2D, width, height);
  return c.toDataURL('image/png');
}

export function jpegDataUri(width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): string {
  const c = createCanvas(width, height);
  draw(c.getContext('2d') as unknown as CanvasRenderingContext2D, width, height);
  return c.toDataURL('image/jpeg', 0.9);
}

/** A colourful "photo": gradients + shapes, so filters/crops/flips are all visible. */
export function drawPhoto(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#ff5e3a');
  g.addColorStop(0.5, '#ffd60a');
  g.addColorStop(1, '#007aff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1d1d1f';
  ctx.fillRect(w * 0.1, h * 0.15, w * 0.25, h * 0.3);
  ctx.fillStyle = '#34c759';
  ctx.beginPath();
  ctx.arc(w * 0.7, h * 0.6, Math.min(w, h) * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w * 0.45, h * 0.05, w * 0.05, h * 0.9);
}

export function drawDark(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#101010';
  ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
}

export const SVG_SRC =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">' +
      '<rect width="120" height="80" fill="#0a84ff"/><circle cx="60" cy="40" r="30" fill="#ffd60a"/>' +
      '<path d="M10 70 L60 10 L110 70 Z" fill="none" stroke="#1d1d1f" stroke-width="4"/></svg>',
  ).toString('base64');

export function imageAsset(src: string, width: number, height: number, mimeType: ImageAsset['mimeType'] = 'image/png'): ImageAsset {
  return { type: 'image', mimeType, width, height, src, name: '', source: null };
}

// ---------------------------------------------------------------------------
// Element / document builders (explicit ids, canonical shape)
// ---------------------------------------------------------------------------

const base = { name: '', rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null } as const;

export function text(id: string, p: Partial<TextElement> & { content: string }): TextElement {
  return {
    ...base,
    id,
    type: 'text',
    x: 40,
    y: 40,
    width: 300,
    height: 60,
    fontFamily: FIXTURE_FAMILY,
    fontWeight: 400,
    fontStyle: 'normal',
    fontSize: 32,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: 'left',
    verticalAlign: 'top',
    fill: '#1d1d1f',
    textDecoration: 'none',
    textTransform: 'none',
    ...p,
  };
}

export function shape(id: string, kind: ShapeElement['shape'], p: Partial<ShapeElement> = {}): ShapeElement {
  return {
    ...base,
    id,
    type: 'shape',
    shape: kind,
    x: 40,
    y: 40,
    width: 120,
    height: 80,
    fill: kind === 'line' ? null : '#ff5e3a',
    stroke: kind === 'line' ? '#1d1d1f' : null,
    strokeWidth: kind === 'line' ? 4 : 0,
    dash: [],
    cornerRadius: 0,
    sides: 5,
    innerRadius: 0.5,
    ...p,
  };
}

export function image(id: string, assetId: string, p: Partial<Omit<ImageElement, 'filters'>> & { filters?: Partial<ImageFilters> } = {}): ImageElement {
  const { filters, ...rest } = p;
  return {
    ...base,
    id,
    type: 'image',
    assetId,
    x: 40,
    y: 40,
    width: 160,
    height: 120,
    crop: null,
    objectFit: 'cover',
    flipX: false,
    flipY: false,
    cornerRadius: 0,
    filters: { ...DEFAULT_FILTERS, ...filters },
    ...rest,
  };
}

export function page(id: string, elements: PlakatElement[], background: Page['background'] = { color: '#ffffff', image: null }): Page {
  return { id, name: '', background, elements };
}

export function makeDoc(size: PageSize | PresetId, pages: Page[], assets: Record<string, ImageAsset> = {}, title = 'Test design'): PlakatDocument {
  const doc: PlakatDocument = {
    format: 'plakat.document',
    schemaVersion: 1,
    kind: 'design',
    id: 'doc_test',
    meta: {
      title,
      description: '',
      tags: [],
      createdAt: '2026-10-08T12:00:00.000Z',
      updatedAt: '2026-10-08T12:00:00.000Z',
      sourceTemplateId: null,
    },
    size: typeof size === 'string' ? presetToPageSize(size) : size,
    pages,
    assets,
    fonts: [],
    template: null,
  };
  assertValidDocument(doc);
  return doc;
}

/** Structural-sharing edit of one element (like an immer recipe would produce). */
export function editElement(doc: PlakatDocument, pageId: string, elId: string, patch: (el: PlakatElement) => PlakatElement): PlakatDocument {
  return {
    ...doc,
    pages: doc.pages.map((p) =>
      p.id !== pageId ? p : { ...p, elements: p.elements.map((e) => (e.id === elId ? patch(e) : e)) },
    ),
  };
}

export function editPage(doc: PlakatDocument, pageId: string, patch: (p: Page) => Page): PlakatDocument {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? patch(p) : p)) };
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

export function rgba(canvas: RenderCanvas): Buffer {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function decodePng(bytes: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

export function pixelAt(buf: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!];
}

/** Number of differing bytes (fast pre-check before pixelmatch). */
export function countDiffBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}
