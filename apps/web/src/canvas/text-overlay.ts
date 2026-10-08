/**
 * Inline text editing overlay (render-export-pipeline.md §2.1): an HTML <textarea> laid
 * over the hidden Konva text node. Its layout is computed in PAGE px (font size, width,
 * letter spacing exactly as the renderer passes them to Konva) and the whole box is mapped
 * to the screen with one CSS matrix (translate · rotate · scale(zoom)), so line breaks are
 * computed at the same font size as Konva's and the overlay scales/rotates with the canvas.
 */
import type { TextElement } from '@plakat/schema';
import type { Point } from './viewport.ts';

export interface TextOverlayInput {
  element: Pick<
    TextElement,
    | 'x'
    | 'y'
    | 'width'
    | 'height'
    | 'rotation'
    | 'opacity'
    | 'fontFamily'
    | 'fontWeight'
    | 'fontStyle'
    | 'fontSize'
    | 'lineHeight'
    | 'letterSpacing'
    | 'align'
    | 'fill'
    | 'textDecoration'
    | 'textTransform'
  >;
  /** Screen position (CSS px, container-relative) of the page origin. */
  pageOrigin: Point;
  zoom: number;
  /** The Konva text node's y inside the element (vertical alignment offset), page px. */
  textOffsetY?: number;
  /** The Konva text node's width (≥ element width), page px. */
  textWidth?: number;
  /** Current measured text height in page px (the textarea grows with it). */
  textHeight?: number;
}

export type Matrix = [number, number, number, number, number, number];

/** Multiplies two 2D affine matrices [a, b, c, d, e, f] (CSS order): returns m1 · m2. */
export function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

export function applyMatrix(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/**
 * Screen matrix of the textarea's local box (page px, origin = text node top-left):
 * T(element origin on screen) · R(rotation) · S(zoom) · T(0, textOffsetY).
 */
export function textOverlayMatrix(input: TextOverlayInput): Matrix {
  const { element: el, pageOrigin, zoom } = input;
  const rad = (el.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const translate: Matrix = [1, 0, 0, 1, pageOrigin.x + el.x * zoom, pageOrigin.y + el.y * zoom];
  const rotate: Matrix = [cos, sin, -sin, cos, 0, 0];
  const scale: Matrix = [zoom, 0, 0, zoom, 0, 0];
  const offset: Matrix = [1, 0, 0, 1, 0, input.textOffsetY ?? 0];
  return multiplyMatrix(multiplyMatrix(multiplyMatrix(translate, rotate), scale), offset);
}

function cssFamily(family: string): string {
  return `"${family.replace(/["\\]/g, '')}", sans-serif`;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** CSS (camelCase, React-style) for the editing textarea. */
export function computeTextOverlayStyle(input: TextOverlayInput): Record<string, string | number> {
  const el = input.element;
  const m = textOverlayMatrix(input).map(round);
  const width = Math.max(input.textWidth ?? el.width, 1);
  const lineHeightPx = el.fontSize * el.lineHeight;
  const height = Math.max(input.textHeight ?? 0, lineHeightPx, 1);
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    margin: 0,
    padding: 0,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    boxSizing: 'content-box',
    resize: 'none',
    overflow: 'hidden',
    transformOrigin: '0 0',
    transform: `matrix(${m.join(', ')})`,
    width: `${round(width)}px`,
    height: `${round(height)}px`,
    fontFamily: cssFamily(el.fontFamily),
    fontSize: `${round(el.fontSize)}px`,
    fontWeight: el.fontWeight,
    fontStyle: el.fontStyle,
    lineHeight: round(el.lineHeight),
    letterSpacing: `${round(el.letterSpacing * el.fontSize)}px`,
    textAlign: el.align,
    textAlignLast: el.align === 'justify' ? 'left' : 'auto',
    textDecoration: el.textDecoration === 'none' ? 'none' : el.textDecoration,
    textTransform: el.textTransform === 'none' ? 'none' : el.textTransform,
    color: el.fill,
    caretColor: el.fill,
    opacity: el.opacity,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: 'normal',
    fontKerning: 'normal',
    fontVariantLigatures: 'normal',
    tabSize: 4,
    zIndex: 5,
  };
}
