/**
 * `@plakat/renderer/node`: the Node RenderEnv (P-2). Importing this module installs
 * Konva's node-canvas backend, so import it BEFORE anything renders.
 *
 *   import { createNodeEnv } from '@plakat/renderer/node';
 *   import { exportDocument } from '@plakat/renderer';
 */
import 'konva/canvas-backend';
import { createCanvas, loadImage as canvasLoadImage, registerFont } from 'canvas';
import { dataUriToBytes, isDataUri, type Asset, type AssetFetcher, type FontLoadRequest, type FontRef, type Id } from '@plakat/schema';
import { encodeCanvasDefault } from './encode.ts';
import { AssetLoadError, FontLoadError } from './errors.ts';
import { svgRasterScale, svgRasterSize } from './resources.ts';
import type { DecodedImage, RenderEnv } from './types.ts';

export interface NodeFontFile {
  /** Path to a .ttf/.otf file. */
  file: string;
  /** Family name used by documents (e.g. "Inter"). */
  family: string;
  /** CSS weight (default 400). */
  weight?: number;
  style?: 'normal' | 'italic';
}

export interface NodeEnvOptions {
  /** Font files, registered with node-canvas `registerFont` when a document first needs the family. */
  fontFiles?: NodeFontFile[];
  /**
   * Fetcher for non-`data:` srcs (root-relative uploads, http). Default: refuse, because
   * srcs in documents are untrusted (SSRF; schema §8). Server code can pass e.g. a reader
   * of its upload directory.
   */
  fetchAsset?: AssetFetcher;
}

export interface NodeRenderEnv extends RenderEnv {
  /** Registers (once) a font file right away. */
  registerFontFile(font: NodeFontFile): void;
  /** Families that have at least one registered file. */
  registeredFamilies(): string[];
}

/** node-canvas registrations are process-global: remember them across envs. */
const registered = new Set<string>();

function fontKey(f: NodeFontFile): string {
  return `${f.file}\u0000${f.family}\u0000${f.weight ?? 400}\u0000${f.style ?? 'normal'}`;
}

function register(f: NodeFontFile): void {
  const key = fontKey(f);
  if (registered.has(key)) return;
  registerFont(f.file, { family: f.family, weight: String(f.weight ?? 400), style: f.style ?? 'normal' });
  registered.add(key);
}

export function createNodeEnv(opts: NodeEnvOptions = {}): NodeRenderEnv {
  const fontFiles = [...(opts.fontFiles ?? [])];
  const images = new Map<string, Promise<DecodedImage>>();
  const families = new Set<string>();

  async function decode(src: string, asset: Asset, assetId: Id, svgScale: number): Promise<DecodedImage> {
    let bytes: Uint8Array;
    try {
      if (isDataUri(src)) bytes = dataUriToBytes(src).bytes;
      else if (opts.fetchAsset) bytes = (await opts.fetchAsset(src, assetId, asset)).bytes;
      else throw new Error(`Non-data asset src not allowed without fetchAsset: ${src.slice(0, 100)}`);
    } catch (err) {
      throw new AssetLoadError(assetId, `Image asset "${assetId}" could not be read`, { cause: err });
    }
    let img: Awaited<ReturnType<typeof canvasLoadImage>>;
    try {
      img = await canvasLoadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch (err) {
      throw new AssetLoadError(assetId, `Image asset "${assetId}" failed to decode`, { cause: err });
    }
    if (asset.mimeType === 'image/svg+xml') {
      const size = svgRasterSize(asset, svgScale);
      const canvas = createCanvas(size.width, size.height);
      // node-canvas renders an SVG at its own width/height and scales that bitmap in
      // drawImage (blurry); resizing the image first makes librsvg render the vector at
      // the raster size, like a browser's drawImage of an SVG <img>.
      img.width = size.width;
      img.height = size.height;
      canvas.getContext('2d').drawImage(img, 0, 0, size.width, size.height);
      return canvas as unknown as DecodedImage;
    }
    if (!(img.width > 0 && img.height > 0)) throw new AssetLoadError(assetId, `Image asset "${assetId}" has no pixels`);
    return img as unknown as DecodedImage;
  }

  return {
    kind: 'node',
    registerFontFile(font) {
      if (!fontFiles.includes(font)) fontFiles.push(font);
      register(font);
      families.add(font.family);
    },
    registeredFamilies() {
      return [...families];
    },
    loadImage(src, asset, assetId, loadOpts) {
      const svg = asset.mimeType === 'image/svg+xml';
      const svgScale = loadOpts?.svgRasterScale ?? svgRasterScale(asset);
      const size = svg ? svgRasterSize(asset, svgScale) : null;
      const key = size ? `${src}#svg:${asset.width}x${asset.height}@${size.width}x${size.height}` : src;
      let p = images.get(key);
      if (!p) {
        p = decode(src, asset, assetId, svgScale);
        images.set(key, p);
        p.catch(() => images.delete(key));
      }
      return p;
    },
    async loadFonts(fonts: FontRef[], _requests: FontLoadRequest[]) {
      const missing: string[] = [];
      for (const font of fonts) {
        const files = fontFiles.filter((f) => f.family === font.family);
        if (files.length === 0) {
          for (const v of font.variants) missing.push(`"${font.family}" ${v.style} ${v.weight}`);
          continue;
        }
        // Variants without their own file are synthesized/matched by the font engine,
        // like a browser does for weights a family lacks (schema §9).
        for (const f of files) register(f);
        families.add(font.family);
      }
      if (missing.length > 0) throw new FontLoadError(missing);
    },
    encodeCanvas: encodeCanvasDefault,
    wrapOutput: (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
  };
}
