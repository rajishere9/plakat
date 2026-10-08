/**
 * Client-side image preparation before upload (REST contract: the server does not
 * rotate). JPEG EXIF orientation is baked by decoding with
 * createImageBitmap(file, { imageOrientation: 'from-image' }) and re-encoding through
 * a canvas; images whose longest side exceeds `maxSide` (6000 px) are downscaled.
 * Files that need neither are passed through byte-for-byte. SVG and GIF are never
 * re-encoded (vector / animation would be lost).
 */
import type { ImageMimeType } from '@plakat/schema';

export const MAX_UPLOAD_SIDE = 6000;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES: readonly ImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
/** `accept` attribute for file inputs. */
export const IMAGE_ACCEPT = SUPPORTED_IMAGE_TYPES.join(',');

export class UnsupportedImageError extends Error {
  override name = 'UnsupportedImageError';
}

export interface DecodedBitmap {
  /** Size AFTER EXIF orientation. */
  width: number;
  height: number;
  source: CanvasImageSource;
  close(): void;
}

/** Decoder/encoder seam (browser implementation by default; tests inject fakes). */
export interface ImageCodec {
  decode(file: Blob): Promise<DecodedBitmap>;
  encode(source: CanvasImageSource, width: number, height: number, mimeType: string, quality: number): Promise<Blob>;
}

export const browserImageCodec: ImageCodec = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
  },
  async encode(source, width, height, mimeType, quality) {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, width, height);
      return canvas.convertToBlob({ type: mimeType, quality });
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), mimeType, quality),
    );
  },
};

export interface NormalizeOptions {
  maxSide?: number;
  /** JPEG/WebP re-encode quality (default 0.92). */
  quality?: number;
  codec?: ImageCodec;
}

export interface NormalizedImage {
  /** What to upload (the original File when untouched). */
  file: File;
  mimeType: ImageMimeType;
  /** Displayed size (after orientation / downscale); null when unknown (e.g. SVG without size). */
  width: number | null;
  height: number | null;
  /** True when the bytes were re-encoded (rotation baked and/or downscaled). */
  transformed: boolean;
  /** EXIF orientation found (1 = none / not JPEG). */
  orientation: number;
}

const EXT_TO_MIME: Record<string, ImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};
const MIME_TO_EXT: Record<ImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/** The file's image MIME type from `file.type`, else its extension; null if unsupported. */
export function detectImageMime(file: { type?: string; name?: string }): ImageMimeType | null {
  const t = (file.type ?? '').toLowerCase();
  if ((SUPPORTED_IMAGE_TYPES as readonly string[]).includes(t)) return t as ImageMimeType;
  if (t === 'image/jpg') return 'image/jpeg';
  const ext = /\.([a-z0-9]+)$/i.exec(file.name ?? '')?.[1]?.toLowerCase();
  return ext ? (EXT_TO_MIME[ext] ?? null) : null;
}

/** Reads the EXIF orientation (1..8) of JPEG bytes; 1 when absent or not a JPEG. */
export function readJpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return 1; // start of scan / end: no EXIF before image data
    const length = view.getUint16(offset + 2);
    if (marker === 0xe1 && offset + 10 <= bytes.length) {
      const start = offset + 4;
      const isExif = view.getUint32(start) === 0x45786966 && view.getUint16(start + 4) === 0; // "Exif\0\0"
      if (isExif) return readTiffOrientation(view, start + 6, Math.min(bytes.length, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return 1;
}

function readTiffOrientation(view: DataView, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const order = view.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return 1;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) === 0x0112) {
      const v = view.getUint16(entry + 8, little);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function parseSvgLength(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px|pt|mm|cm|in)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? 'px').toLowerCase();
  const k = unit === 'pt' ? 96 / 72 : unit === 'mm' ? 96 / 25.4 : unit === 'cm' ? 96 / 2.54 : unit === 'in' ? 96 : 1;
  const px = n * k;
  return px > 0 ? px : null;
}

/** Intrinsic size of SVG markup from width/height attributes, else the viewBox. */
export function readSvgSize(svg: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  const w = parseSvgLength(attr('width'));
  const h = parseSvgLength(attr('height'));
  const vb = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const vbw = vb && vb.length === 4 && vb[2]! > 0 ? vb[2]! : null;
  const vbh = vb && vb.length === 4 && vb[3]! > 0 ? vb[3]! : null;
  if (w && h) return { width: Math.round(w), height: Math.round(h) };
  if (vbw && vbh) {
    if (w) return { width: Math.round(w), height: Math.round((w * vbh) / vbw) };
    if (h) return { width: Math.round((h * vbw) / vbh), height: Math.round(h) };
    return { width: Math.round(vbw), height: Math.round(vbh) };
  }
  return null;
}

async function readBytes(blob: Blob, max: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, max).arrayBuffer());
}

function renameExt(name: string, ext: string): string {
  const base = name.replace(/\.[^.]*$/, '') || 'image';
  return `${base}.${ext}`;
}

/** Fits (w, h) inside maxSide on the longest side (integer px, aspect kept). */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height, scaled: false };
  const k = maxSide / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

/**
 * Prepares a user-picked file for POST /api/uploads. Throws UnsupportedImageError for
 * non-image types and files above 25 MB that cannot be shrunk (SVG/GIF).
 */
export async function normalizeUploadFile(file: File, options: NormalizeOptions = {}): Promise<NormalizedImage> {
  const maxSide = options.maxSide ?? MAX_UPLOAD_SIDE;
  const quality = options.quality ?? 0.92;
  const codec = options.codec ?? browserImageCodec;
  const mimeType = detectImageMime(file);
  if (!mimeType) throw new UnsupportedImageError(`Unsupported file type: ${file.type || file.name}`);

  if (mimeType === 'image/svg+xml') {
    if (file.size > MAX_UPLOAD_BYTES) throw new UnsupportedImageError('SVG files are limited to 25 MB');
    const size = readSvgSize(await file.text());
    return { file, mimeType, width: size?.width ?? null, height: size?.height ?? null, transformed: false, orientation: 1 };
  }
  if (mimeType === 'image/gif') {
    if (file.size > MAX_UPLOAD_BYTES) throw new UnsupportedImageError('GIF files are limited to 25 MB');
    let width: number | null = null;
    let height: number | null = null;
    try {
      const bmp = await codec.decode(file);
      width = bmp.width;
      height = bmp.height;
      bmp.close();
    } catch {
      /* server sniffs the size */
    }
    return { file, mimeType, width, height, transformed: false, orientation: 1 };
  }

  const orientation = mimeType === 'image/jpeg' ? readJpegOrientation(await readBytes(file, 256 * 1024)) : 1;
  const bitmap = await codec.decode(file);
  try {
    const target = fitWithin(bitmap.width, bitmap.height, maxSide);
    const needsEncode = orientation !== 1 || target.scaled || file.size > MAX_UPLOAD_BYTES;
    if (!needsEncode) {
      return { file, mimeType, width: bitmap.width, height: bitmap.height, transformed: false, orientation };
    }
    let blob = await codec.encode(bitmap.source, target.width, target.height, mimeType, quality);
    let outType = (detectImageMime({ type: blob.type }) ?? mimeType) as ImageMimeType;
    if (blob.type && blob.type !== mimeType && outType !== 'image/png' && outType !== 'image/jpeg') {
      blob = await codec.encode(bitmap.source, target.width, target.height, 'image/png', quality);
      outType = 'image/png';
    }
    if (!blob.type) outType = mimeType;
    const out = new File([blob], renameExt(file.name, MIME_TO_EXT[outType]), { type: outType, lastModified: file.lastModified });
    return { file: out, mimeType: outType, width: target.width, height: target.height, transformed: true, orientation };
  } finally {
    bitmap.close();
  }
}
