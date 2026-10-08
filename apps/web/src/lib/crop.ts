/** Crop helpers for crop mode and "Replace image" (all in DECLARED asset px, schema D-19). */
import { computeImageLayout, coverCrop, fitCropToImage, type CropRect, type ImageAsset, type ImageElement } from '@plakat/schema';

type Natural = Pick<ImageAsset, 'width' | 'height'>;

/**
 * The explicit crop crop-mode starts from: the element's crop, else the crop that
 * reproduces its current objectFit (cover -> coverCrop; fill/contain -> whole image,
 * which is what `fill` samples; for `contain` the box keeps its size and the user
 * re-frames from the whole image).
 */
export function initialCrop(el: Pick<ImageElement, 'width' | 'height' | 'crop' | 'objectFit'>, asset: Natural): CropRect {
  if (el.crop) return fitCropToImage(el.crop, asset.width, asset.height);
  if (el.objectFit === 'cover') return coverCrop(el.width, el.height, asset.width, asset.height);
  return computeImageLayout({ ...el, objectFit: 'fill' }, asset).crop;
}

/**
 * Keeps framing when an image element switches to another asset: the old crop is
 * expressed relative to the old image, mapped onto the new one, then made valid with
 * the box aspect (fitCropToImage: no distortion, center kept). A null crop stays null
 * (objectFit re-derives the framing).
 */
export function remapCrop(
  crop: CropRect | null,
  oldAsset: Natural,
  newAsset: Natural,
  box: Pick<ImageElement, 'width' | 'height'>,
): CropRect | null {
  if (!crop) return null;
  const sx = newAsset.width / oldAsset.width;
  const sy = newAsset.height / oldAsset.height;
  const mapped: CropRect = { x: crop.x * sx, y: crop.y * sy, width: crop.width * sx, height: crop.height * sy };
  const aspect = box.width > 0 && box.height > 0 ? box.width / box.height : undefined;
  return fitCropToImage(mapped, newAsset.width, newAsset.height, aspect);
}
