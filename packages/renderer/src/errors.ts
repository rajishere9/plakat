import type { Id } from '@plakat/schema';

/** The font barrier could not make every requested face drawable (§3.1). */
export class FontLoadError extends Error {
  override readonly name = 'FontLoadError';
  /** Human-readable variants, e.g. `"Playfair Display" italic 700`. */
  readonly missing: string[];
  constructor(missing: string[], message?: string) {
    super(message ?? `Fonts could not be loaded: ${missing.join(', ')}`);
    this.missing = missing;
  }
}

/** An image asset could not be decoded (§3.2). Export refuses; the editor draws a placeholder. */
export class AssetLoadError extends Error {
  override readonly name = 'AssetLoadError';
  readonly assetId: Id;
  constructor(assetId: Id, message?: string, options?: { cause?: unknown }) {
    super(message ?? `Image asset "${assetId}" could not be loaded`, options);
    this.assetId = assetId;
  }
}

/** The requested output bitmap is larger than the platform's canvas limits (§4). */
export class CanvasLimitError extends Error {
  override readonly name = 'CanvasLimitError';
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number, reason: string) {
    super(`${reason}. Choose a lower export scale.`);
    this.width = width;
    this.height = height;
  }
}

/** rasterizePage produced a bitmap of the wrong size, or the page frame carries opacity (§4, P-9). */
export class RasterError extends Error {
  override readonly name = 'RasterError';
}
