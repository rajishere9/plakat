import { crc32 } from './zip.ts';
import type { RenderCanvas, RenderEnv } from './types.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Pixels per metre for a DPI value (PNG pHYs uses px/m). */
export function dpiToPixelsPerMetre(dpi: number): number {
  return Math.round(dpi / 0.0254);
}

/**
 * Returns the PNG with a pHYs chunk (unit = metre) for `dpi`, inserted right after IHDR
 * (any existing pHYs is replaced). Returns the input unchanged if it is not a PNG.
 */
export function setPngDpi(bytes: Uint8Array, dpi: number): Uint8Array {
  if (!isPng(bytes)) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let off = 8;
  let inserted = false;
  const ppm = dpiToPixelsPerMetre(dpi);
  const phys = new Uint8Array(12 + 9);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  pv.setUint32(8, ppm);
  pv.setUint32(12, ppm);
  phys[16] = 1; // unit: metre
  pv.setUint32(17, crc32(phys.subarray(4, 17)));
  while (off + 12 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    const end = off + 12 + len;
    if (end > bytes.length) return bytes; // malformed: leave untouched
    if (type !== 'pHYs') chunks.push(bytes.subarray(off, end));
    if (type === 'IHDR' && !inserted) {
      chunks.push(phys);
      inserted = true;
    }
    off = end;
    if (type === 'IEND') break;
  }
  if (!inserted) return bytes;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Reads the pHYs chunk of a PNG (px per unit + unit), or null. */
export function readPngPhys(bytes: Uint8Array): { x: number; y: number; unit: number } | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    if (type === 'pHYs') return { x: view.getUint32(off + 8), y: view.getUint32(off + 12), unit: bytes[off + 16]! };
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return null;
}

/**
 * Sets the JFIF APP0 density to `dpi` dots per inch (in place on a copy), when the JPEG
 * starts with a JFIF APP0 segment. Otherwise returns the input unchanged.
 */
export function setJpegDpi(bytes: Uint8Array, dpi: number): Uint8Array {
  // FFD8 FFE0 <len:2> 'JFIF\0' <ver:2> <units:1> <Xdensity:2> <Ydensity:2>
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes[3] !== 0xe0) return bytes;
  if (String.fromCharCode(bytes[6]!, bytes[7]!, bytes[8]!, bytes[9]!) !== 'JFIF' || bytes[10] !== 0) return bytes;
  const out = bytes.slice();
  const d = Math.min(0xffff, Math.round(dpi));
  out[13] = 1; // dots per inch
  out[14] = d >> 8;
  out[15] = d & 0xff;
  out[16] = d >> 8;
  out[17] = d & 0xff;
  return out;
}

/** Reads the JFIF density (units, x, y) or null. */
export function readJpegDensity(bytes: Uint8Array): { unit: number; x: number; y: number } | null {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes[3] !== 0xe0) return null;
  if (String.fromCharCode(bytes[6]!, bytes[7]!, bytes[8]!, bytes[9]!) !== 'JFIF') return null;
  return { unit: bytes[13]!, x: (bytes[14]! << 8) | bytes[15]!, y: (bytes[16]! << 8) | bytes[17]! };
}

interface NodeCanvasLike {
  toBuffer(mime: string, config?: unknown): Uint8Array;
}

/**
 * Default canvas encoder: node-canvas `toBuffer` under Node, `toBlob` in browsers.
 * JPEG quality is in 0..1.
 */
export async function encodeCanvasDefault(
  canvas: RenderCanvas,
  mimeType: 'image/png' | 'image/jpeg',
  quality?: number,
): Promise<Uint8Array> {
  const nodeCanvas = canvas as unknown as Partial<NodeCanvasLike>;
  if (typeof nodeCanvas.toBuffer === 'function') {
    const buf = mimeType === 'image/jpeg' ? nodeCanvas.toBuffer('image/jpeg', { quality: quality ?? 0.92 }) : nodeCanvas.toBuffer('image/png');
    return buf;
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`Canvas could not be encoded as ${mimeType}`))), mimeType, quality);
    } catch (err) {
      // SecurityError: a tainted (non-CORS) image was drawn (P-4).
      reject(err);
    }
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export function encodeCanvas(env: RenderEnv, canvas: RenderCanvas, mimeType: 'image/png' | 'image/jpeg', quality?: number): Promise<Uint8Array> {
  return env.encodeCanvas ? env.encodeCanvas(canvas, mimeType, quality) : encodeCanvasDefault(canvas, mimeType, quality);
}
