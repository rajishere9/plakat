import { describe, expect, it } from 'vitest';
import { getElementBounds } from '@plakat/schema';
import { el, makeStore, page0, rect } from './test-helpers.ts';

const order = (store: Parameters<typeof page0>[0]) => page0(store).elements.map((e) => e.id);

describe('z-order', () => {
  it('forward / backward / front / back with multi-selection blocks', () => {
    const { store } = makeStore(['a', 'b', 'c', 'd', 'e'].map((id) => rect(id, 0, 0, 1, 1)));
    const a = store.getState().actions;
    a.bringForward(['a', 'b']);
    expect(order(store)).toEqual(['c', 'a', 'b', 'd', 'e']);
    a.sendBackward(['b']);
    expect(order(store)).toEqual(['c', 'b', 'a', 'd', 'e']);
    a.bringToFront(['c', 'a']);
    expect(order(store)).toEqual(['b', 'd', 'e', 'c', 'a']);
    a.sendToBack(['e', 'a']);
    expect(order(store)).toEqual(['e', 'a', 'b', 'd', 'c']);
    a.bringForward(['c']); // already on top: no-op, no history entry
    a.undo();
    expect(order(store)).toEqual(['b', 'd', 'e', 'c', 'a']);
    a.moveElementToIndex('a', 0);
    expect(order(store)[0]).toBe('a');
    expect(store.getState().lastChange?.ids).toEqual([]);
    expect(store.getState().lastChange?.pages).toEqual([page0(store).id]);
  });
});

describe('group / ungroup', () => {
  it('groups the selection and selecting one member selects all', () => {
    const { store } = makeStore([rect('a', 0, 0, 1, 1), rect('b', 0, 0, 1, 1), rect('c', 0, 0, 1, 1)]);
    const a = store.getState().actions;
    a.select(['a', 'b']);
    const g = a.group()!;
    expect(el(store, 'a').groupId).toBe(g);
    expect(el(store, 'b').groupId).toBe(g);
    a.select(['a']);
    expect(store.getState().selectedIds).toEqual(['a', 'b']);
    a.select(['a'], { expandGroups: false });
    expect(store.getState().selectedIds).toEqual(['a']);
    a.ungroup(['a']);
    expect(el(store, 'b').groupId).toBeNull();
    expect(a.group(['c'])).toBeNull();
  });
});

describe('align', () => {
  it('single element aligns to the page', () => {
    const { store } = makeStore([rect('a', 10, 10, 100, 50)]);
    const a = store.getState().actions;
    a.align('right', ['a']);
    expect(el(store, 'a').x).toBe(900);
    a.align('middle', ['a']);
    expect(el(store, 'a').y).toBe(475);
    a.align('center', ['a']);
    expect(el(store, 'a').x).toBe(450);
  });

  it('multi aligns to the selection bounds, using rotated AABBs', () => {
    const { store } = makeStore([rect('a', 100, 100, 100, 100), rect('b', 400, 300, 100, 50, { rotation: 90 })]);
    const a = store.getState().actions;
    // b rotated 90° about its origin: AABB x = 350..400, y = 300..400
    a.align('left', ['a', 'b']);
    expect(el(store, 'a').x).toBe(100);
    expect(getElementBounds(el(store, 'b')).x).toBeCloseTo(100);
    a.align('bottom', ['a', 'b']);
    expect(getElementBounds(el(store, 'a')).y + 100).toBeCloseTo(400);
    expect(getElementBounds(el(store, 'b')).y + 100).toBeCloseTo(400);
  });

  it('a group counts as one unit; locked units stay', () => {
    const { store } = makeStore([
      rect('a', 0, 0, 10, 10, { groupId: 'g' }),
      rect('b', 40, 0, 10, 10, { groupId: 'g' }),
      rect('l', 500, 500, 10, 10, { locked: true }),
    ]);
    const a = store.getState().actions;
    a.align('right', ['a']); // the group alone -> page
    expect(el(store, 'a').x).toBe(950);
    expect(el(store, 'b').x).toBe(990);
    a.align('left', ['a', 'l']);
    expect(el(store, 'a').x).toBe(500);
    expect(el(store, 'l').x).toBe(500);
  });
});

describe('distribute & nudge', () => {
  it('distributes horizontally with equal gaps', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 30, 10), rect('c', 100, 0, 20, 10)]);
    store.getState().actions.distribute('horizontal', ['c', 'a', 'b']);
    // span 0..120, widths 60 -> gap 30: b at 40
    expect(el(store, 'b').x).toBe(40);
    expect(el(store, 'a').x).toBe(0);
    expect(el(store, 'c').x).toBe(100);
  });

  it('nudge moves unlocked selection and coalesces', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('l', 0, 0, 10, 10, { locked: true })]);
    const a = store.getState().actions;
    a.select(['a', 'l']);
    a.nudge(10, 0);
    a.nudge(0, -1);
    expect(el(store, 'a')).toMatchObject({ x: 10, y: -1 });
    expect(el(store, 'l')).toMatchObject({ x: 0, y: 0 });
    a.undo();
    expect(el(store, 'a')).toMatchObject({ x: 0, y: 0 });
  });
});
