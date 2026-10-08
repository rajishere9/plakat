/**
 * Test-only fixture documents (render-export-pipeline.md §6.1). Not exported from the package.
 */
import type { PlakatDocument } from '@plakat/schema';
import {
  FIXTURE_FAMILY,
  LATE_FAMILY,
  SVG_SRC,
  drawDark,
  drawPhoto,
  image,
  imageAsset,
  jpegDataUri,
  makeDoc,
  page,
  pngDataUri,
  shape,
  text,
} from './test-support.ts';

let assetsMemo: Record<string, ReturnType<typeof imageAsset>> | null = null;

/** Generated fixture assets (memoized: data URIs are deterministic). */
export function fixtureAssets(): Record<string, ReturnType<typeof imageAsset>> {
  if (assetsMemo) return assetsMemo;
  assetsMemo = {
    as_photo: imageAsset(pngDataUri(200, 150, drawPhoto), 200, 150),
    // Declared 200×150 but decoded at half resolution (a "rendition"): crops must scale.
    as_half: imageAsset(pngDataUri(100, 75, drawPhoto), 200, 150),
    as_dark: imageAsset(pngDataUri(64, 64, drawDark), 64, 64),
    as_jpeg: imageAsset(jpegDataUri(90, 120, drawPhoto), 90, 120, 'image/jpeg'),
    as_svg: imageAsset(SVG_SRC, 120, 80, 'image/svg+xml'),
  };
  return assetsMemo;
}

const LATIN_EXT_CYRILLIC = 'Zażółć gęślą jaźń. Съешь же ещё этих мягких булок';

/**
 * The "kitchen sink" A4 (fractional page) document: two pages; page `pg_b` covers every
 * element type and shape kind, rotation (15°, 90°), opacity on fill+stroke, dashes, all
 * filters, crop/cover/contain/fill, flips, corner radii, every textTransform, verticalAlign
 * and justify, hidden elements, background image, narrow text boxes, latin-ext + Cyrillic,
 * a half-resolution rendition with an explicit crop, an SVG, and a filtered image whose
 * width × 3.125 is not an integer. Page `pg_a` has a transparent background.
 */
export function kitchenSinkDoc(): PlakatDocument {
  const assets = fixtureAssets();
  const pageA = page(
    'pg_a',
    [
      shape('el_a_rect', 'rect', { x: 50, y: 60, width: 300, height: 200, fill: '#34c75980', cornerRadius: 24 }),
      text('el_a_title', { x: 60, y: 300, width: 600, height: 120, content: 'Page one', fontSize: 64, fontWeight: 700 }),
      image('el_a_img', 'as_photo', { x: 400, y: 500, width: 300, height: 220, rotation: -8 }),
    ],
    { color: null, image: null },
  );
  const pageB = page(
    'pg_b',
    [
      shape('el_rect', 'rect', {
        x: 40.5,
        y: 30.25,
        width: 220,
        height: 140,
        fill: '#ff5e3a',
        stroke: '#1d1d1f',
        strokeWidth: 6,
        cornerRadius: 18,
        rotation: 15,
        opacity: 0.6,
        dash: [12, 6],
      }),
      shape('el_ellipse', 'ellipse', { x: 300, y: 40, width: 160, height: 100, fill: '#007aff', stroke: '#ffd60a', strokeWidth: 3 }),
      shape('el_line', 'line', { x: 500, y: 60, width: 240, height: 10, stroke: '#1d1d1f', strokeWidth: 5, dash: [20, 10], rotation: 30 }),
      shape('el_triangle', 'triangle', { x: 40, y: 220, width: 120, height: 100, fill: '#34c759' }),
      shape('el_polygon', 'polygon', { x: 190, y: 220, width: 120, height: 110, sides: 6, fill: '#af52de', stroke: '#000000', strokeWidth: 2 }),
      shape('el_star', 'star', { x: 340, y: 220, width: 130, height: 130, sides: 7, innerRadius: 0.45, rotation: 90, fill: '#ffd60a', stroke: '#1d1d1f', strokeWidth: 4, opacity: 0.85 }),
      shape('el_hidden', 'rect', { x: 0, y: 0, width: 800, height: 800, fill: '#ff0000', hidden: true }),
      image('el_cover', 'as_photo', { x: 40, y: 380, width: 150, height: 150, objectFit: 'cover' }),
      image('el_contain', 'as_photo', { x: 210, y: 380, width: 150, height: 150, objectFit: 'contain' }),
      image('el_fill', 'as_jpeg', { x: 380, y: 380, width: 150, height: 100, objectFit: 'fill', flipX: true }),
      image('el_crop', 'as_photo', { x: 550, y: 380, width: 120, height: 90, crop: { x: 20, y: 30, width: 80, height: 60 }, flipY: true, cornerRadius: 16 }),
      image('el_half', 'as_half', { x: 690, y: 380, width: 90, height: 120, crop: { x: 110, y: 10, width: 60, height: 80 } }),
      image('el_svg', 'as_svg', { x: 40, y: 550, width: 180, height: 120, rotation: 15 }),
      image('el_bright', 'as_photo', { x: 240, y: 550, width: 100.3, height: 75.2, filters: { brightness: 25 } }),
      image('el_contrast', 'as_photo', { x: 360, y: 550, width: 100, height: 75, filters: { contrast: 40, saturation: -60 } }),
      image('el_sat', 'as_photo', { x: 480, y: 550, width: 100, height: 75, filters: { saturation: 80, sepia: true } }),
      image('el_gray', 'as_photo', { x: 600, y: 550, width: 100, height: 75, filters: { grayscale: true, invert: true } }),
      image('el_blur', 'as_photo', { x: 240, y: 650, width: 101.7, height: 76.3, filters: { blur: 6 }, rotation: 90 }),
      text('el_upper', { x: 40, y: 700, width: 360, height: 40, content: 'uppercase me', textTransform: 'uppercase', letterSpacing: 0.08 }),
      text('el_lower', { x: 40, y: 745, width: 360, height: 40, content: 'LOWERCASE ME', textTransform: 'lowercase', textDecoration: 'underline' }),
      text('el_cap', { x: 40, y: 790, width: 360, height: 40, content: 'capitalize each word', textTransform: 'capitalize', textDecoration: 'line-through' }),
      text('el_middle', {
        x: 420,
        y: 700,
        width: 330,
        height: 160,
        content: 'Middle aligned text in a tall box',
        verticalAlign: 'middle',
        align: 'center',
        fontWeight: 700,
        fill: '#007aff',
      }),
      text('el_bottom', { x: 420, y: 880, width: 330, height: 120, content: 'Bottom right', verticalAlign: 'bottom', align: 'right', opacity: 0.7 }),
      text('el_justify', {
        x: 40,
        y: 840,
        width: 360,
        height: 100,
        fontSize: 18,
        content: 'Justified paragraph text that wraps over several lines so the justification is visible in the raster output.',
        align: 'justify',
      }),
      text('el_overflow', { x: 40, y: 950, width: 200, height: 20, fontSize: 20, content: 'This text is taller than its box and overflows downward.' }),
      text('el_narrow0', { x: 300, y: 950, width: 0, height: 30, fontSize: 22, content: 'W i d e' }),
      text('el_narrow', { x: 360, y: 950, width: 5, height: 30, fontSize: 22, content: 'MMM mm', letterSpacing: 0.2 }),
      text('el_intl', { x: 420, y: 1010, width: 340, height: 80, fontSize: 20, content: LATIN_EXT_CYRILLIC, rotation: -3 }),
      text('el_late', {
        x: 40,
        y: 1040,
        width: 330,
        height: 60,
        fontSize: 24,
        content: 'Late font: wraps across more than one centred line',
        align: 'center',
        fontFamily: LATE_FAMILY,
      }),
    ],
    { color: '#f4efe6', image: { assetId: 'as_photo' } },
  );
  return makeDoc('a4-poster', [pageA, pageB], assets, 'Kitchen sink — A4');
}

export { FIXTURE_FAMILY };
