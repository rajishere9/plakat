// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShapeElement } from '@plakat/schema';
import { createTestServices, docWith, renderWithServices } from '../app/test-utils.tsx';
import { LayersPanel, visualDropToIndex } from './LayersPanel.tsx';

afterEach(cleanup);

const shape = (id: string, name: string) => createShapeElement('rect', { id, name, x: 0, y: 0, width: 10, height: 10 });

function setup() {
  // Array order is bottom -> top: a (bottom), b, c, d (top).
  const services = createTestServices({ document: docWith([shape('a', 'A'), shape('b', 'B'), shape('c', 'C'), shape('d', 'D')]) });
  renderWithServices(<LayersPanel />, services);
  const order = () => services.store.getState().document.pages[0]!.elements.map((e) => e.id).join('');
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-layer-id]')];
  return { store: services.store, order, rows };
}

/** jsdom has no DragEvent: build the event and pin clientY on it. */
function drag(kind: 'dragOver' | 'drop', el: HTMLElement, dataTransfer: unknown, clientY: number) {
  const evt = createEvent[kind](el, { dataTransfer });
  Object.defineProperty(evt, 'clientY', { value: clientY });
  fireEvent(el, evt);
}

function mockRect(el: HTMLElement, top: number, height = 40) {
  el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

describe('visualDropToIndex', () => {
  it('maps visual (top-first) drop positions to final array indices', () => {
    // 4 elements; visual order = [3, 2, 1, 0].
    expect(visualDropToIndex(4, 0, 0, 'before')).toBe(3); // bottom -> above the topmost
    expect(visualDropToIndex(4, 3, 3, 'after')).toBe(0); // top -> below the bottom-most
    expect(visualDropToIndex(4, 0, 1, 'before')).toBe(2); // bottom -> above element at index 2
    expect(visualDropToIndex(4, 3, 1, 'after')).toBe(2); // top -> just below element at index 2
    expect(visualDropToIndex(4, 1, 2, 'before')).toBe(1); // dropping right above itself = no move
  });
});

describe('LayersPanel', () => {
  it('lists layers topmost first', () => {
    const { rows } = setup();
    expect(rows().map((r) => r.dataset['layerId'])).toEqual(['d', 'c', 'b', 'a']);
  });

  it('reorders by drag and drop', () => {
    const { order, rows, store } = setup();
    const spy = vi.spyOn(store.getState().actions, 'moveElementToIndex');
    rows().forEach((r, i) => mockRect(r, i * 40));
    const [dRow, , , aRow] = rows();
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', effectAllowed: '', dropEffect: '', types: [] };
    // Drag the bottom layer (a) above the top layer (d).
    fireEvent.dragStart(aRow!, { dataTransfer });
    drag('dragOver', dRow!, dataTransfer, 5);
    drag('drop', dRow!, dataTransfer, 5);
    expect(spy).toHaveBeenCalledWith('a', 3);
    expect(order()).toBe('bcda');
    // Drag the new top layer (a) below c: visual order is a, d, c, b.
    const rows2 = rows();
    rows2.forEach((r, i) => mockRect(r, i * 40));
    expect(rows2.map((r) => r.dataset['layerId'])).toEqual(['a', 'd', 'c', 'b']);
    fireEvent.dragStart(rows2[0]!, { dataTransfer });
    drag('dragOver', rows2[2]!, dataTransfer, 2 * 40 + 35);
    drag('drop', rows2[2]!, dataTransfer, 2 * 40 + 35);
    expect(order()).toBe('bacd');
  });

  it('reorders with Alt+Arrow keys and selects on click', () => {
    const { order, store } = setup();
    const btnC = screen.getByRole('button', { name: 'C' });
    fireEvent.click(btnC);
    expect(store.getState().selectedIds).toEqual(['c']);
    fireEvent.keyDown(btnC, { key: 'ArrowUp', altKey: true });
    expect(order()).toBe('abdc');
    fireEvent.keyDown(screen.getByRole('button', { name: 'A' }), { key: 'ArrowDown', altKey: true });
    expect(order()).toBe('abdc'); // already the bottom-most: no move
  });

  it('toggles lock and visibility, and renames inline', () => {
    const { store } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Lock B' }));
    expect(store.getState().document.pages[0]!.elements[1]!.locked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hide B' }));
    expect(store.getState().document.pages[0]!.elements[1]!.hidden).toBe(true);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'D' }));
    const input = screen.getByRole('textbox', { name: 'Rename D' });
    fireEvent.change(input, { target: { value: 'Headline box' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store.getState().document.pages[0]!.elements[3]!.name).toBe('Headline box');
  });

  it('shows a slot badge for template slot targets', () => {
    const { store } = setup();
    act(() => store.getState().actions.convertToTemplate());
    act(() => {
      store.getState().actions.addSlot({ kind: 'color', targets: ['b'], label: 'Accent' });
    });
    expect(screen.getByTitle('Template slot: Accent')).toBeTruthy();
  });
});
