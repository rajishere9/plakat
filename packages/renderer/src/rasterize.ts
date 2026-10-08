import { SceneCanvas } from 'konva/lib/Canvas';
import { exportPixelSize, type ExportScaleId } from '@plakat/schema';
import { RasterError } from './errors.ts';
import type { PageScene } from './scene.ts';
import type { RenderCanvas } from './types.ts';

/**
 * THE raster function for editor and export (§4, P-9). Draws `scene.root` in root-local
 * space (`root.drawScene(canvas, root)`), so stage zoom/pan, page-frame offsets, other
 * pages and the chrome layer can never reach the bitmap (P-12). Returns a canvas of
 * EXACTLY `exportPixelSize(scene.size, scale)` device pixels (asserted).
 *
 * The scene is switched to pixel ratio `s` for the draw (content scale + filter caches)
 * and restored afterwards. The caller owns the returned canvas; release it with
 * `Konva.Util.releaseCanvas(canvas)` when done.
 *
 * In browsers the result is an HTMLCanvasElement; under Node a node-canvas `Canvas`.
 */
export function rasterizePage(scene: PageScene, scale: number | ExportScaleId): RenderCanvas {
  const { width: W, height: H, pixelRatio: s } = exportPixelSize(scene.size, scale);
  const previous = scene.pixelRatio;
  scene.setPixelRatio(s);
  try {
    if ((scene.root.getParent()?.getAbsoluteOpacity() ?? 1) !== 1) {
      throw new RasterError('page frame must not carry opacity');
    }
    // willReadFrequently keeps the raster on the CPU (Skia software) backend in
    // browsers. Every raster is read back (toBlob), and a CPU surface makes the result
    // independent of whether Chrome happens to GPU-accelerate a given canvas (GPU memory
    // pressure from the editor's on-screen layers varies), so editor snapshots and
    // exports are produced by the same rasterizer.
    const canvas = new SceneCanvas({ width: (W + 0.5) / s, height: (H + 0.5) / s, pixelRatio: s, willReadFrequently: true });
    if (canvas._canvas.width !== W || canvas._canvas.height !== H) {
      throw new RasterError(`raster size mismatch: got ${canvas._canvas.width}x${canvas._canvas.height}, expected ${W}x${H}`);
    }
    try {
      scene.root.drawScene(canvas, scene.root);
    } finally {
      canvas._releaseIsolationCanvas();
    }
    return canvas._canvas;
  } finally {
    scene.setPixelRatio(previous);
  }
}
