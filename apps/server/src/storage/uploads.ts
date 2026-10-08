import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { HttpError } from '../errors.ts';
import { EXTENSION_MIME, MIME_EXTENSIONS, readImageInfo, type ImageMimeType } from '../images/dimensions.ts';

/** Public URL prefix of stored uploads. */
export const UPLOADS_PREFIX = '/uploads/';

/** `<sha256>.<ext>` — the only file names ever served or read from the upload dir. */
export const UPLOAD_FILE_PATTERN = /^([a-f0-9]{64})\.(png|jpg|webp|gif|svg)$/;

/** Max declared dimension accepted by the document schema. */
const MAX_DIMENSION = 100_000;

export interface UploadAttribution {
  title: string | null;
  creator: string | null;
  creatorUrl: string | null;
  license: string | null;
  licenseUrl: string | null;
  pageUrl: string | null;
  provider: string;
}

/** Response shape of POST /api/uploads (and the base of provider imports). */
export interface StoredUpload {
  src: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

export interface StoreOptions {
  /** Original client file name (informational, stored in the DB only). */
  filename?: string;
  attribution?: UploadAttribution | null;
}

/** Content-addressed image store: bytes on disk under `<dir>/<sha256>.<ext>`, metadata in `uploads`. */
export class UploadStore {
  constructor(
    private readonly db: Db,
    readonly dir: string,
    readonly maxBytes: number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Validates (magic-byte sniffing, never the client's declared type), stores and
   * records an image. Idempotent per content hash. Throws HttpError 413/415/422.
   */
  async store(bytes: Uint8Array, options: StoreOptions = {}): Promise<StoredUpload> {
    if (bytes.byteLength > this.maxBytes) throw new HttpError(413, 'payload_too_large', `File exceeds ${this.maxBytes} bytes`);
    if (bytes.byteLength === 0) throw new HttpError(400, 'empty_file', 'The file is empty');
    const info = readImageInfo(bytes);
    if (!info) {
      throw new HttpError(415, 'unsupported_media_type', 'Only PNG, JPEG, WebP, GIF and SVG images are accepted');
    }
    if (info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
      throw new HttpError(422, 'image_too_large', `Image dimensions exceed ${MAX_DIMENSION}px`);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = `${sha256}.${MIME_EXTENSIONS[info.mimeType]}`;
    const target = path.join(this.dir, file);
    if (!(await exists(target))) {
      const tmp = path.join(this.dir, `.${file}.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(tmp, bytes);
      try {
        await rename(tmp, target);
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
      }
    }
    await this.db.query(
      `INSERT INTO uploads (sha256, filename, mime_type, width, height, byte_size, attribution)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (sha256) DO UPDATE SET attribution = COALESCE(uploads.attribution, EXCLUDED.attribution)`,
      [
        sha256,
        (options.filename ?? file).slice(0, 255),
        info.mimeType,
        info.width,
        info.height,
        bytes.byteLength,
        options.attribution ? JSON.stringify(options.attribution) : null,
      ],
    );
    return { src: UPLOADS_PREFIX + file, mimeType: info.mimeType, width: info.width, height: info.height, byteSize: bytes.byteLength, sha256 };
  }

  /** Absolute path for a served file name, or null if the name is not a valid upload file name. */
  pathFor(file: string): string | null {
    return UPLOAD_FILE_PATTERN.test(file) ? path.join(this.dir, file) : null;
  }

  /** Mime type for a valid upload file name. */
  mimeFor(file: string): ImageMimeType | null {
    const m = UPLOAD_FILE_PATTERN.exec(file);
    return m ? (EXTENSION_MIME[m[2]!] ?? null) : null;
  }

  /** Reads an upload by its `src` (`/uploads/<sha>.<ext>`); null if not an upload src or missing. */
  async readBySrc(src: string): Promise<Uint8Array | null> {
    if (!src.startsWith(UPLOADS_PREFIX)) return null;
    const p = this.pathFor(src.slice(UPLOADS_PREFIX.length));
    if (!p) return null;
    try {
      return new Uint8Array(await readFile(p));
    } catch {
      return null;
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
