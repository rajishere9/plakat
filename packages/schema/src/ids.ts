import { customAlphabet } from 'nanoid';

/** Every id in a Plakat file (documents, pages, elements, assets, slots, groups). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Ids that match ID_PATTERN but are refused because they collide with
 * Object.prototype machinery when used as record keys or `in` lookups.
 */
export const RESERVED_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export type IdPrefix = 'doc' | 'pg' | 'el' | 'as' | 'slot' | 'grp' | 'bk' | 'bc' | 'bf' | 'bl';

// Alphanumeric only (no '_' / '-') so ids double-click-select cleanly in editors.
const random = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 12);

/** Creates a new random id such as `el_V1StGXR8Z5jd`. */
export function createId(prefix: IdPrefix): string {
  return `${prefix}_${random()}`;
}

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && !RESERVED_IDS.has(value);
}

/** Own-property lookup that never sees inherited members (`toString`, `__proto__`, ...). */
export function hasOwnKey(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

/**
 * Plain-JSON deep copy. Unlike structuredClone it works on immer drafts (Proxies),
 * so every clone helper can run inside a `produce()` recipe. Documents are pure
 * JSON, so nothing is lost.
 */
export function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = deepCopy((value as Record<string, unknown>)[key]);
    return out as T;
  }
  return value;
}

/** Structural equality on plain JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
