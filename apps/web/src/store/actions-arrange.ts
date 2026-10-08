/** Arrange actions: z-order, grouping, align, distribute, nudge. */
import { createId, type Id, type PlakatElement } from '@plakat/schema';
import { computeAlign, computeDistribute, toAlignUnits } from '../lib/align.ts';
import { elementIndex, expandGroups, findDraftElement, findDraftPage, targetIds, type ActionContext } from './internal.ts';
import type { EditorActions } from './types.ts';

type ArrangeKeys =
  | 'bringForward'
  | 'sendBackward'
  | 'bringToFront'
  | 'sendToBack'
  | 'moveElementToIndex'
  | 'group'
  | 'ungroup'
  | 'align'
  | 'distribute'
  | 'nudge';

/** Moves every selected element one step up past the next unselected element (blocks move together). */
export function orderForward<T extends { id: Id }>(arr: readonly T[], sel: ReadonlySet<Id>): T[] {
  const out = [...arr];
  for (let i = out.length - 2; i >= 0; i--) {
    if (sel.has(out[i]!.id) && !sel.has(out[i + 1]!.id)) [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
  }
  return out;
}

export function orderBackward<T extends { id: Id }>(arr: readonly T[], sel: ReadonlySet<Id>): T[] {
  const out = [...arr];
  for (let i = 1; i < out.length; i++) {
    if (sel.has(out[i]!.id) && !sel.has(out[i - 1]!.id)) [out[i], out[i - 1]] = [out[i - 1]!, out[i]!];
  }
  return out;
}

export function orderToFront<T extends { id: Id }>(arr: readonly T[], sel: ReadonlySet<Id>): T[] {
  return [...arr.filter((e) => !sel.has(e.id)), ...arr.filter((e) => sel.has(e.id))];
}

export function orderToBack<T extends { id: Id }>(arr: readonly T[], sel: ReadonlySet<Id>): T[] {
  return [...arr.filter((e) => sel.has(e.id)), ...arr.filter((e) => !sel.has(e.id))];
}

export function createArrangeActions(ctx: ActionContext): Pick<EditorActions, ArrangeKeys> {
  const { get, commit } = ctx;

  const reorder = (label: string, ids: Id[] | undefined, fn: (arr: readonly PlakatElement[], sel: ReadonlySet<Id>) => PlakatElement[]) => {
    const sel = new Set(expandGroups(get().document, targetIds(ctx, ids)));
    if (sel.size === 0) return;
    commit(label, (d, base) => {
      for (const page of base.pages) {
        if (!page.elements.some((e) => sel.has(e.id))) continue;
        const next = fn(page.elements, sel);
        if (next.every((e, i) => e === page.elements[i])) continue;
        findDraftPage(d, page.id)!.elements = next;
      }
    });
  };

  /** Selected elements (expanded to groups) of the selection's page. */
  const selectedElements = (ids?: Id[]): PlakatElement[] => {
    const doc = get().document;
    const idx = elementIndex(doc);
    const list = expandGroups(doc, targetIds(ctx, ids));
    const pageId = list[0] ? idx.get(list[0])?.page.id : undefined;
    return list.map((id) => idx.get(id)).filter((h) => !!h && h.page.id === pageId).map((h) => h!.element);
  };

  const translate = (label: string, moves: Map<Id, { dx: number; dy: number }>, extra: { coalesceKey?: string } = {}) => {
    if (moves.size === 0) return;
    commit(
      label,
      (d) => {
        for (const [id, { dx, dy }] of moves) {
          const el = findDraftElement(d, id);
          if (!el) continue;
          el.x += dx;
          el.y += dy;
        }
      },
      { touched: [...moves.keys()], ...extra },
    );
  };

  return {
    bringForward: (ids) => reorder('Bring forward', ids, orderForward),
    sendBackward: (ids) => reorder('Send backward', ids, orderBackward),
    bringToFront: (ids) => reorder('Bring to front', ids, orderToFront),
    sendToBack: (ids) => reorder('Send to back', ids, orderToBack),

    moveElementToIndex(id, toIndex) {
      commit('Reorder', (d) => {
        for (const page of d.pages) {
          const from = page.elements.findIndex((e) => e.id === id);
          if (from === -1) continue;
          const to = Math.min(Math.max(Math.round(toIndex), 0), page.elements.length - 1);
          if (to === from) return;
          const [el] = page.elements.splice(from, 1);
          page.elements.splice(to, 0, el!);
          return;
        }
      });
    },

    group(ids) {
      const els = selectedElements(ids);
      if (els.length < 2) return null;
      const groupId = createId('grp');
      const list = els.map((e) => e.id);
      commit(
        'Group',
        (d) => {
          for (const id of list) {
            const el = findDraftElement(d, id);
            if (el) el.groupId = groupId;
          }
        },
        { select: list },
      );
      return groupId;
    },

    ungroup(ids) {
      const doc = get().document;
      const idx = elementIndex(doc);
      const groups = new Set(
        targetIds(ctx, ids)
          .map((id) => idx.get(id)?.element.groupId)
          .filter((g): g is Id => !!g),
      );
      if (groups.size === 0) return;
      commit('Ungroup', (d) => {
        for (const page of d.pages) for (const el of page.elements) if (el.groupId && groups.has(el.groupId)) el.groupId = null;
      });
    },

    align(edge, ids) {
      const els = selectedElements(ids);
      if (!els.length) return;
      translate(`Align ${edge}`, computeAlign(toAlignUnits(els), edge, get().document.size));
    },

    distribute(axis, ids) {
      const els = selectedElements(ids);
      translate(axis === 'horizontal' ? 'Distribute horizontally' : 'Distribute vertically', computeDistribute(toAlignUnits(els), axis));
    },

    nudge(dx, dy, ids) {
      const els = selectedElements(ids).filter((e) => !e.locked);
      if (!els.length || (!dx && !dy)) return;
      const moves = new Map(els.map((e) => [e.id, { dx, dy }] as const));
      translate('Nudge', moves, { coalesceKey: `nudge:${els.map((e) => e.id).sort().join(',')}` });
    },
  };
}
