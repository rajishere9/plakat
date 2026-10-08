/**
 * Dependency-free image header parsers: type sniffing (magic bytes, never the
 * client-declared type) and natural dimensions for PNG, JPEG, WebP, GIF and SVG.
 *
 * JPEG dimensions honour the EXIF Orientation tag (5..8 swap width/height) so the
 * reported size is "as displayed", matching the document schema's declared-size rule.
 */

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml';

export interface ImageInfo {
  mimeType: ImageMimeType;
  /** Natural size as displayed (after EXIF orientation), integer px >= 1. */
  width: number;
  height: number;
}

export const MIME_EXTENSIONS: Record<ImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

export const EXTENSION_MIME: Record<string, ImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, o: number) => (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Identifies the image type from magic bytes (SVG: by its root element). */
export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  if (bytes.length >= 8 && PNG_SIG.every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (findSvgRootTag(bytes) !== null) return 'image/svg+xml';
  return null;
}

/** Sniffs the type and reads the dimensions; null when unsupported or corrupt. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const mimeType = sniffImageType(bytes);
  if (!mimeType) return null;
  let size: { width: number; height: number } | null;
  switch (mimeType) {
    case 'image/png':
      size = pngSize(bytes);
      break;
    case 'image/jpeg':
      size = jpegSize(bytes);
      break;
    case 'image/webp':
      size = webpSize(bytes);
      break;
    case 'image/gif':
      size = gifSize(bytes);
      break;
    case 'image/svg+xml':
      size = svgSize(bytes);
      break;
  }
  if (!size || !(size.width >= 1) || !(size.height >= 1)) return null;
  return { mimeType, width: size.width, height: size.height };
}

export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  // signature(8) + length(4) + "IHDR"(4) + width(4) + height(4)
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

export function gifSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 10) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

export function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 25) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    if (b.length < 30) return null;
    // frame tag (3) then start code 9d 01 2a, then 14-bit width/height (2 bits scale).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const b0 = b[21]!, b1 = b[22]!, b2 = b[23]!, b3 = b[24]!;
    return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) };
  }
  if (chunk === 'VP8X') {
    if (b.length < 30) return null;
    return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return null;
}

/** EXIF orientation (1..8) from an APP1 "Exif" segment payload, or 1. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (ascii(b, start, 6) !== 'Exif\0\0') return 1;
  const tiff = start + 6;
  const order = ascii(b, tiff, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const le = order === 'II';
  const r16 = (o: number) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o: number) => (le ? ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0 : u32be(b, o));
  if (r16(tiff + 2) !== 42) return 1;
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (r16(entry) === 0x0112) {
      const v = r16(entry + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

export function jpegSize(b: Uint8Array): { width: number; height: number; orientation: number } | null {
  let o = 2;
  let orientation = 1;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    let marker = b[o + 1]!;
    // Fill bytes.
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1]!;
    }
    // Standalone markers (no length).
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    const segStart = o + 4;
    const segEnd = Math.min(b.length, o + 2 + len);
    if (marker === 0xe1) orientation = Math.max(orientation, exifOrientation(b, segStart, segEnd));
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (segStart + 5 > b.length) return null;
      const height = u16be(b, segStart + 1);
      const width = u16be(b, segStart + 3);
      return orientation >= 5 ? { width: height, height: width, orientation } : { width, height, orientation };
    }
    o += 2 + len;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const SVG_SCAN_BYTES = 64 * 1024;

/** Returns the attribute text of the root <svg ...> tag, or null if this is not an SVG document. */
function findSvgRootTag(bytes: Uint8Array): string | null {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, SVG_SCAN_BYTES));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let i = 0;
  const n = text.length;
  for (;;) {
    while (i < n && /\s/.test(text[i]!)) i++;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      if (end === -1) return null;
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      if (end === -1) return null;
      i = end + 3;
    } else if (/^<!DOCTYPE/i.test(text.slice(i, i + 9))) {
      // May contain an internal subset [...]
      const bracket = text.indexOf('[', i);
      const close = text.indexOf('>', i);
      if (close === -1) return null;
      if (bracket !== -1 && bracket < close) {
        const endSubset = text.indexOf(']', bracket);
        if (endSubset === -1) return null;
        const end = text.indexOf('>', endSubset);
        if (end === -1) return null;
        i = end + 1;
      } else i = close + 1;
    } else break;
  }
  const m = /^<svg(?=[\s>/])/.exec(text.slice(i, i + 5));
  if (!m) return null;
  // Scan to the end of the start tag, respecting quoted attribute values.
  let j = i + 4;
  let quote: string | null = null;
  for (; j < n; j++) {
    const c = text[j]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return text.slice(i + 4, j);
  }
  return null;
}

const UNIT_PX: Record<string, number> = { '': 1, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 4 / 3, pc: 16 };

/** Parses an SVG length to px; null for %, em, ex, invalid or non-positive values. */
export function parseSvgLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(value);
  if (!m) return null;
  const factor = UNIT_PX[m[2]!.toLowerCase()];
  if (factor === undefined) return null;
  const px = Number(m[1]) * factor;
  return Number.isFinite(px) && px > 0 ? px : null;
}

function parseAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) attrs.set(m[1]!, m[2] ?? m[3] ?? '');
  return attrs;
}

/** Default size browsers give an SVG without usable width/height/viewBox. */
export const SVG_FALLBACK_SIZE = { width: 300, height: 150 } as const;

export function svgSize(bytes: Uint8Array): { width: number; height: number } | null {
  const tag = findSvgRootTag(bytes);
  if (tag === null) return null;
  const attrs = parseAttributes(tag);
  let w = parseSvgLength(attrs.get('width'));
  let h = parseSvgLength(attrs.get('height'));
  const vb = attrs
    .get('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const vbOk = vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0;
  if (vbOk) {
    const [, , vw, vh] = vb as [number, number, number, number];
    if (w === null && h === null) {
      w = vw;
      h = vh;
    } else if (w === null) w = (h! * vw) / vh;
    else if (h === null) h = (w * vh) / vw;
  }
  if (w === null || h === null) {
    if (w === null && h === null) return { ...SVG_FALLBACK_SIZE };
    // One side known, no viewBox: browsers use 300x150 for the unknown side.
    w ??= SVG_FALLBACK_SIZE.width;
    h ??= SVG_FALLBACK_SIZE.height;
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}
