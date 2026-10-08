/**
 * Shared helpers for the template tooling (generator, preview, tests).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToDataUri, type AssetSource, type ImageAsset, type ImageMimeType } from '@plakat/schema';

/** Absolute path of the repo's `templates/` directory. */
export const TEMPLATES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directory holding the source images that templates embed (`templates/assets/`). */
export const ASSET_DIR = join(TEMPLATES_ROOT, 'assets');

/** Built-in template file suffix. */
export const TEMPLATE_SUFFIX = '.plakat.json';

/** `<slug>` part of `templates/<category>/<slug>.plakat.json`: lowercase kebab-case. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every `*.plakat.json` below `root` (sorted, absolute; skips dot-dirs and node_modules). */
export function findTemplateFiles(root: string = TEMPLATES_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(TEMPLATE_SUFFIX)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Pixel size of a PNG or JPEG from its header (no decoding). */
export function imageSize(bytes: Uint8Array): { width: number; height: number; mimeType: ImageMimeType } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return { width: view.getUint32(16), height: view.getUint32(20), mimeType: 'image/png' };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1]!;
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7), mimeType: 'image/jpeg' };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      i += 2 + view.getUint16(i + 2);
    }
    throw new Error('JPEG without a SOF marker');
  }
  throw new Error('Only PNG and JPEG template assets are supported');
}

/** Provenance recorded on every built-in placeholder image (asset.source). */
export const PLACEHOLDER_SOURCE: AssetSource = {
  provider: 'plakat-templates',
  externalId: null,
  pageUrl: null,
  author: 'Plakat contributors',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'Placeholder artwork by Plakat contributors (CC0 1.0)',
};

/** Reads `templates/assets/<file>` into a portable (data URI) image asset. */
export function loadTemplateAsset(file: string, name: string, source: AssetSource = PLACEHOLDER_SOURCE): ImageAsset {
  const bytes = new Uint8Array(readFileSync(join(ASSET_DIR, file)));
  const { width, height, mimeType } = imageSize(bytes);
  return { type: 'image', mimeType, width, height, src: bytesToDataUri(bytes, mimeType), name, source: { ...source } };
}
