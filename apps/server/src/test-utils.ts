/** Shared helpers for server tests (not a test file itself). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from './app.ts';
import { loadConfig, type Config } from './config.ts';

export interface TestApp {
  app: FastifyInstance;
  config: Config;
  dir: string;
  close(): Promise<void>;
}

/** Tests never touch the network: remote fetches fail unless a test injects `fetch`. */
export const offlineFetch = (async (input: string | URL | Request) => {
  throw new TypeError(`network disabled in tests (${String(input instanceof Request ? input.url : input)})`);
}) as typeof fetch;

/** Every non-IP host "resolves" to a public documentation-free address; `*.internal` to a private one. */
export const fakeResolveHost = async (host: string): Promise<string[]> => (host.endsWith('.internal') ? ['10.0.0.8'] : ['93.184.216.34']);

/** buildApp() on in-memory PGlite with temp upload/templates dirs. */
export async function createTestApp(options: BuildAppOptions & { templatesDir?: string; env?: Record<string, string> } = {}): Promise<TestApp> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plakat-server-test-'));
  const config = loadConfig({
    PGLITE: 'memory',
    DATA_DIR: dir,
    TEMPLATES_DIR: options.templatesDir ?? path.join(dir, 'templates-missing'),
    LOG_LEVEL: 'silent',
    ...options.env,
  });
  const { templatesDir: _t, env: _e, ...rest } = options;
  const app = await buildApp(config, { logger: false, fetch: offlineFetch, resolveHost: fakeResolveHost, ...rest });
  return {
    app,
    config,
    dir,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Image byte fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A real, decodable RGBA PNG filled with one color. */
export function makePng(width: number, height: number, rgba: [number, number, number, number] = [255, 0, 0, 255]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) raw.set(rgba, row + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

/** JPEG header bytes: SOI, optional APP1/Exif orientation, APP0, SOF0 (or SOF2), EOI. */
export function makeJpeg(width: number, height: number, opts: { orientation?: number; littleEndian?: boolean; progressive?: boolean } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  // APP0 JFIF
  const jfif = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  parts.push(Buffer.from([0xff, 0xe0, 0x00, jfif.length + 2]), jfif);
  if (opts.orientation) {
    const le = opts.littleEndian ?? false;
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write(le ? 'II' : 'MM', 0, 'ascii');
    const w16 = (v: number, o: number) => (le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
    const w32 = (v: number, o: number) => (le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
    w16(42, 2);
    w32(8, 4);
    w16(1, 8); // one entry
    w16(0x0112, 10); // Orientation
    w16(3, 12); // SHORT
    w32(1, 14); // count
    w16(opts.orientation, 18);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    parts.push(Buffer.from([0xff, 0xe1]), len, payload);
  }
  // DQT-ish filler segment to make sure we skip unknown segments
  parts.push(Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]));
  const sof = Buffer.alloc(2 + 2 + 15);
  sof[0] = 0xff;
  sof[1] = opts.progressive ? 0xc2 : 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function riff(chunkType: string, chunk: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(chunkType, 0, 'ascii');
  header.writeUInt32LE(chunk.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), header, chunk]);
  const out = Buffer.alloc(8);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(body.length, 4);
  return Buffer.concat([out, body]);
}

export function makeWebpVp8(width: number, height: number): Buffer {
  const c = Buffer.alloc(10);
  c.set([0x9d, 0x01, 0x2a], 3);
  c.writeUInt16LE(width & 0x3fff, 6);
  c.writeUInt16LE(height & 0x3fff, 8);
  return riff('VP8 ', c);
}

export function makeWebpVp8l(width: number, height: number): Buffer {
  const c = Buffer.alloc(5);
  c[0] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  const bits = (w & 0x3fff) | ((h & 0x3fff) << 14);
  c.writeUInt32LE(bits >>> 0, 1);
  return riff('VP8L', c);
}

export function makeWebpVp8x(width: number, height: number): Buffer {
  const c = Buffer.alloc(10);
  c.writeUIntLE(width - 1, 4, 3);
  c.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', c);
}

export function makeGif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13 + 1);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  b[13] = 0x3b;
  return b;
}

// ---------------------------------------------------------------------------
// Multipart
// ---------------------------------------------------------------------------

export function multipartBody(
  field: string,
  filename: string,
  contentType: string,
  data: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----plakat${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
