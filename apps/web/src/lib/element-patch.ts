/**
 * Validates / clamps a partial element update against the schema ranges
 * (validation.ts) so a slider or a typed value can never produce an invalid document.
 * Invalid values (NaN, bad colors, unknown enum members, fields that do not exist on
 * the element type) are dropped; out-of-range numbers are clamped.
 */
import {
  COLOR_PATTERN,
  FONT_FAMILY_PATTERN,
  isValidId,
  normalizeRotation,
  type FontWeight,
  type ImageElement,
  type ImageFilters,
  type PlakatElement,
  type ShapeElement,
  type TextElement,
} from '@plakat/schema';

type Fields<E> = Omit<E, 'id' | 'type'>;

/** A partial update of one element (id/type are never patchable; filters may be partial). */
export type ElementPatch =
  | Partial<Fields<TextElement>>
  | Partial<Fields<ShapeElement>>
  | Partial<Omit<Fields<ImageElement>, 'filters'> & { filters: Partial<ImageFilters> }>;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

type Rule = (v: unknown) => unknown;
const DROP = Symbol('drop');

const range =
  (min: number, max: number): Rule =>
  (v) => {
    const n = num(v);
    return n === undefined ? DROP : clamp(n, min, max);
  };
const positive =
  (max: number, min = 0.01): Rule =>
  (v) => {
    const n = num(v);
    return n === undefined ? DROP : clamp(n, min, max);
  };
const bool: Rule = (v) => (typeof v === 'boolean' ? v : DROP);
const oneOf =
  (...values: string[]): Rule =>
  (v) => (typeof v === 'string' && values.includes(v) ? v : DROP);
const color: Rule = (v) => (typeof v === 'string' && COLOR_PATTERN.test(v) ? v.toLowerCase() : DROP);
const nullableColor: Rule = (v) => (v === null ? null : color(v));
const str =
  (max: number): Rule =>
  (v) => (typeof v === 'string' ? v.slice(0, max) : DROP);

const COMMON: Record<string, Rule> = {
  name: str(200),
  x: range(-1e6, 1e6),
  y: range(-1e6, 1e6),
  width: range(0, 100_000),
  height: range(0, 100_000),
  rotation: (v) => {
    const n = num(v);
    return n === undefined ? DROP : normalizeRotation(n);
  },
  opacity: range(0, 1),
  locked: bool,
  hidden: bool,
  groupId: (v) => (v === null || isValidId(v) ? v : DROP),
};

const TEXT: Record<string, Rule> = {
  content: str(100_000),
  fontFamily: (v) => (typeof v === 'string' && FONT_FAMILY_PATTERN.test(v) ? v : DROP),
  fontWeight: (v) => {
    const n = num(v);
    return n === undefined ? DROP : (clamp(Math.round(n / 100) * 100, 100, 900) as FontWeight);
  },
  fontStyle: oneOf('normal', 'italic'),
  fontSize: positive(5_000),
  lineHeight: range(0.5, 5),
  letterSpacing: range(-1, 5),
  align: oneOf('left', 'center', 'right', 'justify'),
  verticalAlign: oneOf('top', 'middle', 'bottom'),
  fill: color,
  textDecoration: oneOf('none', 'underline', 'line-through'),
  textTransform: oneOf('none', 'uppercase', 'lowercase', 'capitalize'),
};

const SHAPE: Record<string, Rule> = {
  shape: oneOf('rect', 'ellipse', 'line', 'triangle', 'polygon', 'star'),
  fill: nullableColor,
  stroke: nullableColor,
  strokeWidth: range(0, 1_000),
  dash: (v) =>
    Array.isArray(v)
      ? v
          .filter((d): d is number => num(d) !== undefined)
          .map((d) => clamp(d, 0, 10_000))
          .slice(0, 16)
      : DROP,
  cornerRadius: range(0, 100_000),
  sides: (v) => {
    const n = num(v);
    return n === undefined ? DROP : clamp(Math.round(n), 3, 64);
  },
  innerRadius: range(0.05, 0.95),
};

const IMAGE: Record<string, Rule> = {
  assetId: (v) => (isValidId(v) ? v : DROP),
  crop: (v) => {
    if (v === null) return null;
    if (!v || typeof v !== 'object') return DROP;
    const c = v as Record<string, unknown>;
    const x = num(c['x']);
    const y = num(c['y']);
    const w = num(c['width']);
    const h = num(c['height']);
    if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return DROP;
    return { x: Math.max(0, x), y: Math.max(0, y), width: w, height: h };
  },
  objectFit: oneOf('cover', 'contain', 'fill'),
  flipX: bool,
  flipY: bool,
  cornerRadius: range(0, 100_000),
};

const FILTERS: Record<keyof ImageFilters, Rule> = {
  brightness: range(-100, 100),
  contrast: range(-100, 100),
  saturation: range(-100, 100),
  blur: range(0, 100),
  grayscale: bool,
  sepia: bool,
  invert: bool,
};

/** Sanitizes partial filters (unknown keys dropped, numbers clamped). */
export function sanitizeFilters(patch: Partial<Record<string, unknown>>): Partial<ImageFilters> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const rule = (FILTERS as Record<string, Rule>)[k];
    if (!rule) continue;
    const r = rule(v);
    if (r !== DROP) out[k] = r;
  }
  return out as Partial<ImageFilters>;
}

export interface SanitizedPatch {
  /** Fields to assign (filters already merged with the element's current filters). */
  patch: Record<string, unknown>;
  /** Keys that were dropped (unknown for this element type, or invalid). */
  rejected: string[];
}

/** Sanitizes `patch` for `el`. Never includes `id` / `type`. */
export function sanitizeElementPatch(el: PlakatElement, patch: Record<string, unknown>): SanitizedPatch {
  const rules: Record<string, Rule> = {
    ...COMMON,
    ...(el.type === 'text' ? TEXT : el.type === 'shape' ? SHAPE : IMAGE),
  };
  const out: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'filters' && el.type === 'image') {
      if (value && typeof value === 'object') out['filters'] = { ...el.filters, ...sanitizeFilters(value as Record<string, unknown>) };
      else rejected.push(key);
      continue;
    }
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
    if (!rule) {
      rejected.push(key);
      continue;
    }
    const r = rule(value);
    if (r === DROP) rejected.push(key);
    else out[key] = r;
  }
  return { patch: out, rejected };
}
