// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageElement, createShapeElement, createTextElement, type ImageElement, type ShapeElement, type TextElement } from '@plakat/schema';
import { createTestServices, docWith, renderWithServices } from '../../app/test-utils.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';

afterEach(cleanup);

const text = () => createTextElement({ id: 't1', x: 10, y: 20, width: 300, height: 50, content: 'Hello', fontFamily: 'Inter', fontWeight: 400, fontSize: 32 });
const rect = () => createShapeElement('rect', { id: 'r1', x: 100, y: 100, width: 200, height: 100, fill: '#ff0000', stroke: null, strokeWidth: 0 });
const star = () => createShapeElement('star', { id: 's1', x: 0, y: 0, width: 100, height: 100, sides: 5, innerRadius: 0.5 });

function setup(elements: (TextElement | ShapeElement | ImageElement)[], selected: string[], extraAssets = {}) {
  const doc = docWith(elements);
  Object.assign(doc.assets, extraAssets);
  const services = createTestServices({ document: doc });
  act(() => services.store.getState().actions.select(selected));
  const r = renderWithServices(<PropertiesPanel />, services);
  const el = (id: string) => services.store.getState().document.pages[0]!.elements.find((e) => e.id === id)!;
  return { ...r, store: services.store, el };
}

function typeInto(input: HTMLElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('PropertiesPanel', () => {
  it('shows page settings when nothing is selected', () => {
    setup([text()], []);
    expect(screen.getByRole('complementary', { name: 'Page properties' })).toBeTruthy();
    expect(screen.getByText('Design size')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Page background color/ })).toBeTruthy();
  });

  it('text: font size, bold, alignment and letter spacing dispatch store actions', () => {
    const { store, el } = setup([text()], ['t1']);
    const actions = store.getState().actions;
    const updateSpy = vi.spyOn(actions, 'updateElements');
    const boldSpy = vi.spyOn(actions, 'toggleBold');

    typeInto(screen.getByRole('textbox', { name: 'Font size' }), '48');
    expect(updateSpy).toHaveBeenCalledWith(['t1'], { fontSize: 48 }, expect.objectContaining({ label: 'Font size' }));
    expect((el('t1') as TextElement).fontSize).toBe(48);

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(boldSpy).toHaveBeenCalledWith(['t1']);
    expect((el('t1') as TextElement).fontWeight).toBe(700);

    fireEvent.click(screen.getByRole('radio', { name: 'Align center' }));
    expect((el('t1') as TextElement).align).toBe('center');

    typeInto(screen.getByRole('textbox', { name: 'Letter spacing (em)' }), '0.05');
    expect((el('t1') as TextElement).letterSpacing).toBeCloseTo(0.05);

    fireEvent.change(screen.getByRole('combobox', { name: 'Letter case' }), { target: { value: 'uppercase' } });
    expect((el('t1') as TextElement).textTransform).toBe('uppercase');
  });

  it('position, size, rotation and opacity edits update the element', () => {
    const { store, el } = setup([rect()], ['r1']);
    const rotSpy = vi.spyOn(store.getState().actions, 'setRotation');
    typeInto(screen.getByRole('textbox', { name: 'X position' }), '150');
    expect(el('r1').x).toBe(150);
    // Aspect ratio is locked by default for shapes: width 400 -> height 200.
    typeInto(screen.getByRole('textbox', { name: 'Width' }), '400');
    expect(el('r1').width).toBe(400);
    expect(el('r1').height).toBe(200);
    typeInto(screen.getByRole('textbox', { name: 'Rotation' }), '45');
    expect(rotSpy).toHaveBeenCalledWith(['r1'], 45, expect.anything());
    expect(el('r1').rotation).toBe(45);
    typeInto(screen.getByRole('textbox', { name: 'Opacity value' }), '50');
    expect(el('r1').opacity).toBeCloseTo(0.5);
  });

  it('shape: stroke width, corner radius and star points', () => {
    const { el, unmount } = setup([rect()], ['r1']);
    expect(screen.getByText('Corner radius')).toBeTruthy();
    typeInto(screen.getByRole('textbox', { name: 'Corner radius value' }), '12');
    expect((el('r1') as ShapeElement).cornerRadius).toBe(12);
    unmount();

    const s = setup([star()], ['s1']);
    typeInto(screen.getByRole('textbox', { name: 'Points value' }), '8');
    expect((s.el('s1') as ShapeElement).sides).toBe(8);
    typeInto(screen.getByRole('textbox', { name: 'Inner radius value' }), '30');
    expect((s.el('s1') as ShapeElement).innerRadius).toBeCloseTo(0.3);
  });

  it('image: crop enters crop mode, flips and filters dispatch actions', () => {
    const asset = { type: 'image', mimeType: 'image/png', width: 400, height: 300, src: '/uploads/a.png', name: 'a', source: null } as const;
    const img = createImageElement('as_1', asset, { id: 'i1', x: 0, y: 0, width: 400, height: 300 });
    const { store, el } = setup([img], ['i1'], { as_1: asset });
    const filterSpy = vi.spyOn(store.getState().actions, 'setFilters');
    fireEvent.click(screen.getByRole('button', { name: 'Crop' }));
    expect(store.getState().cropModeId).toBe('i1');
    fireEvent.click(screen.getByRole('button', { name: 'Flip horizontally' }));
    expect((el('i1') as ImageElement).flipX).toBe(true);
    typeInto(screen.getByRole('textbox', { name: 'Brightness value' }), '25');
    expect(filterSpy).toHaveBeenCalledWith(['i1'], { brightness: 25 }, expect.anything());
    expect((el('i1') as ImageElement).filters.brightness).toBe(25);
    fireEvent.click(screen.getByRole('switch', { name: 'Grayscale' }));
    expect((el('i1') as ImageElement).filters.grayscale).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect((el('i1') as ImageElement).filters.grayscale).toBe(false);
    expect((el('i1') as ImageElement).filters.brightness).toBe(0);
  });

  it('align and z-order buttons call the arrange actions', () => {
    const { store, el } = setup([rect(), createShapeElement('ellipse', { id: 'e1', x: 0, y: 0, width: 50, height: 50 })], ['r1']);
    const alignSpy = vi.spyOn(store.getState().actions, 'align');
    fireEvent.click(screen.getByRole('button', { name: 'Align left (page)' }));
    expect(alignSpy).toHaveBeenCalledWith('left');
    expect(el('r1').x).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Bring to front' }));
    expect(store.getState().document.pages[0]!.elements.at(-1)!.id).toBe('r1');
    // Distribute needs 3 units.
    expect((screen.getByRole('button', { name: 'Distribute horizontally' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('locked selections are read-only until unlocked', () => {
    const { store } = setup([{ ...rect(), locked: true }], ['r1']);
    const body = screen.getByRole('complementary', { name: 'Element properties' }).querySelector('fieldset')!;
    expect(body.disabled).toBe(true);
    fireEvent.click(within(screen.getByRole('complementary')).getAllByRole('button', { name: 'Unlock' })[0]!);
    expect(store.getState().document.pages[0]!.elements[0]!.locked).toBe(false);
  });

  it('template documents offer "Mark as slot" for the selected element', () => {
    const { store } = setup([text()], []);
    act(() => store.getState().actions.convertToTemplate('poster'));
    act(() => store.getState().actions.select(['t1']));
    fireEvent.click(screen.getByRole('button', { name: 'Mark as text slot' }));
    const slots = store.getState().document.template!.slots;
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ kind: 'text', targets: ['t1'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Required' }));
    expect(store.getState().document.template!.slots[0]!.required).toBe(true);
  });
});
