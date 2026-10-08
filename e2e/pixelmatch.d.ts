// Minimal typings for pixelmatch 7 (ships without .d.ts); test-only dependency.
declare module 'pixelmatch' {
  export interface PixelmatchOptions {
    threshold?: number;
    includeAA?: boolean;
    alpha?: number;
    aaColor?: [number, number, number];
    diffColor?: [number, number, number];
    diffColorAlt?: [number, number, number] | null;
    diffMask?: boolean;
  }
  export default function pixelmatch(
    img1: Uint8Array | Uint8ClampedArray,
    img2: Uint8Array | Uint8ClampedArray,
    output: Uint8Array | Uint8ClampedArray | null | undefined,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
