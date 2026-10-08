/**
 * Minimal ZIP writer (P-11): STORE method only (PNG/JPG are already compressed),
 * CRC-32, local file headers, central directory, end-of-central-directory record.
 * UTF-8 file names (general purpose bit 11). No ZIP64: total size must stay < 4 GiB
 * and fewer than 65 535 entries.
 */

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (crcTable = t);
}

/** CRC-32 (IEEE 802.3, as used by ZIP and PNG). Pass a previous value to continue a running CRC. */
export function crc32(data: Uint8Array, previous = 0): number {
  const t = table();
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive ('/' separators, no leading slash). */
  name: string;
  data: Uint8Array;
  /** Modification time (default: now). Stored in MS-DOS format (2 s resolution, local time). */
  date?: Date;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION = 20; // 2.0: needed for directories / deflate; fine for STORE

/** Builds a STORE zip archive. */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new RangeError('Too many zip entries');
  const enc = new TextEncoder();
  const prepared = entries.map((e) => {
    const name = enc.encode(e.name);
    if (name.length > 0xffff) throw new RangeError(`Zip entry name too long: ${e.name}`);
    return { name, data: e.data, crc: crc32(e.data), dt: dosDateTime(e.date ?? new Date()) };
  });
  let localSize = 0;
  let centralSize = 0;
  for (const p of prepared) {
    localSize += 30 + p.name.length + p.data.length;
    centralSize += 46 + p.name.length;
  }
  const total = localSize + centralSize + 22;
  if (total > 0xffffffff) throw new RangeError('Zip archive larger than 4 GiB (ZIP64 unsupported)');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  const offsets: number[] = [];
  for (const p of prepared) {
    offsets.push(off);
    view.setUint32(off, LOCAL_HEADER_SIG, true);
    view.setUint16(off + 4, VERSION, true);
    view.setUint16(off + 6, UTF8_FLAG, true);
    view.setUint16(off + 8, 0, true); // method: STORE
    view.setUint16(off + 10, p.dt.time, true);
    view.setUint16(off + 12, p.dt.date, true);
    view.setUint32(off + 14, p.crc, true);
    view.setUint32(off + 18, p.data.length, true); // compressed size
    view.setUint32(off + 22, p.data.length, true); // uncompressed size
    view.setUint16(off + 26, p.name.length, true);
    view.setUint16(off + 28, 0, true); // extra length
    out.set(p.name, off + 30);
    out.set(p.data, off + 30 + p.name.length);
    off += 30 + p.name.length + p.data.length;
  }
  const centralStart = off;
  prepared.forEach((p, i) => {
    view.setUint32(off, CENTRAL_HEADER_SIG, true);
    view.setUint16(off + 4, VERSION, true); // version made by
    view.setUint16(off + 6, VERSION, true); // version needed
    view.setUint16(off + 8, UTF8_FLAG, true);
    view.setUint16(off + 10, 0, true);
    view.setUint16(off + 12, p.dt.time, true);
    view.setUint16(off + 14, p.dt.date, true);
    view.setUint32(off + 16, p.crc, true);
    view.setUint32(off + 20, p.data.length, true);
    view.setUint32(off + 24, p.data.length, true);
    view.setUint16(off + 28, p.name.length, true);
    view.setUint16(off + 30, 0, true); // extra
    view.setUint16(off + 32, 0, true); // comment
    view.setUint16(off + 34, 0, true); // disk number
    view.setUint16(off + 36, 0, true); // internal attrs
    view.setUint32(off + 38, 0, true); // external attrs
    view.setUint32(off + 42, offsets[i]!, true);
    out.set(p.name, off + 46);
    off += 46 + p.name.length;
  });
  view.setUint32(off, EOCD_SIG, true);
  view.setUint16(off + 4, 0, true);
  view.setUint16(off + 6, 0, true);
  view.setUint16(off + 8, prepared.length, true);
  view.setUint16(off + 10, prepared.length, true);
  view.setUint32(off + 12, off - centralStart, true);
  view.setUint32(off + 16, centralStart, true);
  view.setUint16(off + 20, 0, true);
  return out;
}

/** Reads a STORE zip back (used by tests; verifies signatures, sizes and CRCs). */
export function readStoredZip(bytes: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (eocd < 0 || view.getUint32(eocd, true) !== EOCD_SIG) throw new Error('zip: missing end of central directory');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  let off = view.getUint32(eocd + 16, true);
  if (off + cdSize !== eocd) throw new Error('zip: central directory size/offset mismatch');
  const dec = new TextDecoder();
  const out: { name: string; data: Uint8Array; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(off, true) !== CENTRAL_HEADER_SIG) throw new Error('zip: bad central header');
    const method = view.getUint16(off + 10, true);
    const crc = view.getUint32(off + 16, true);
    const csize = view.getUint32(off + 20, true);
    const usize = view.getUint32(off + 24, true);
    const nlen = view.getUint16(off + 28, true);
    const elen = view.getUint16(off + 30, true);
    const clen = view.getUint16(off + 32, true);
    const local = view.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nlen));
    if (method !== 0 || csize !== usize) throw new Error(`zip: ${name} is not STORE`);
    if (view.getUint32(local, true) !== LOCAL_HEADER_SIG) throw new Error('zip: bad local header');
    if (view.getUint32(local + 14, true) !== crc || view.getUint32(local + 18, true) !== csize) throw new Error('zip: local/central mismatch');
    const lnlen = view.getUint16(local + 26, true);
    const lelen = view.getUint16(local + 28, true);
    const lname = dec.decode(bytes.subarray(local + 30, local + 30 + lnlen));
    if (lname !== name) throw new Error('zip: local/central name mismatch');
    const start = local + 30 + lnlen + lelen;
    const data = bytes.subarray(start, start + csize);
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name}`);
    out.push({ name, data, crc });
    off += 46 + nlen + elen + clen;
  }
  return out;
}
