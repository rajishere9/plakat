/** Helpers shared by the properties sections. */
import type { JSX, ReactNode } from 'react';
import type { Id, PlakatElement } from '@plakat/schema';
import type { EditorActions, ElementPatch } from '../../store/index.ts';

/** The common value of `get` across elements, or null when mixed / empty. */
export function commonValue<E extends PlakatElement, T>(els: readonly E[], get: (el: E) => T): T | null {
  if (els.length === 0) return null;
  const first = get(els[0]!);
  for (let i = 1; i < els.length; i++) {
    const v = get(els[i]!);
    if (JSON.stringify(v) !== JSON.stringify(first)) return null;
  }
  return first;
}

/**
 * Patches the given elements; consecutive edits of the same field on the same
 * selection within the coalescing window become one undo step (slider drags,
 * arrow-key steps, color drags).
 */
export function patchElements(actions: EditorActions, ids: readonly Id[], field: string, patch: ElementPatch, label?: string): void {
  if (ids.length === 0) return;
  actions.updateElements([...ids], patch, { coalesceKey: `prop:${field}:${ids.join(',')}`, ...(label ? { label } : {}) });
}

export function PropRow({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }): JSX.Element {
  return (
    <div className="prop-row">
      {htmlFor ? (
        <label className="prop-row__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="prop-row__label">{label}</span>
      )}
      <div className="prop-row__control">{children}</div>
    </div>
  );
}
