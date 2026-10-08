// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShapeElement, createTextElement, instantiateTemplate, saveAsTemplate, type PlakatDocument } from '@plakat/schema';
import type { TemplateSummary } from '../api/index.ts';
import { TemplatesPanel } from '../panels/TemplatesPanel.tsx';
import { createApiStub, createPersistenceStub, createTestServices, docWith, renderWithServices } from './test-utils.tsx';
import { Home } from './Home.tsx';
import { buildSlotFills, emptyFillValues, validateFillValues } from './UseTemplateDialog.tsx';

afterEach(cleanup);

function template(): PlakatDocument {
  const design = docWith([
    createTextElement({ id: 'title', content: 'Your headline here', width: 600, height: 80 }),
    createTextElement({ id: 'sub', content: 'Line one\nLine two', width: 600, height: 80, y: 200 }),
    createShapeElement('rect', { id: 'box', width: 100, height: 100, fill: '#ff0000', y: 400 }),
  ]);
  return saveAsTemplate(
    design,
    [
      { kind: 'text', targets: ['title'], label: 'Headline', required: true, maxLength: 12, multiline: false },
      { kind: 'text', targets: ['sub'], label: 'Subtitle' },
      { kind: 'color', targets: ['box'], label: 'Accent', palette: ['#00ff00', '#0000ff'] },
    ],
    { title: 'Promo' },
  );
}

const summary = (t: PlakatDocument): TemplateSummary =>
  ({ id: 'tpl1', title: t.meta.title, category: null, builtIn: true, size: t.size, pageCount: 1, thumbnailUrl: null, updatedAt: '2026-01-01T00:00:00Z' }) as unknown as TemplateSummary;

describe('fill form helpers', () => {
  it('validates required, max length and single-line slots; empty fields keep the template', () => {
    const t = template();
    const slots = t.template!.slots;
    const values = emptyFillValues(t);
    const [title, sub, accent] = slots.map((s) => s.id) as [string, string, string];
    expect(validateFillValues(slots, values)).toEqual({ [title]: 'Required' });
    values[title] = { kind: 'text', text: 'Much too long title' };
    expect(validateFillValues(slots, values)[title]).toBe('At most 12 characters');
    values[title] = { kind: 'text', text: 'Big sale' };
    values[accent] = { kind: 'color', color: '#0000ff' };
    expect(validateFillValues(slots, values)).toEqual({});
    const fills = buildSlotFills(slots, values);
    expect(fills).toEqual({ [title]: { text: 'Big sale' }, [accent]: { color: '#0000ff' } });
    expect(Object.hasOwn(fills, sub)).toBe(false);
    const doc = instantiateTemplate(t, fills);
    expect(doc.pages[0]!.elements.map((e) => (e.type === 'text' ? e.content : e.type === 'shape' ? e.fill : null))).toEqual(['Big sale', 'Line one\nLine two', '#0000ff']);
  });
});

describe('Use template flow', () => {
  it('Home "Use template" shows the fill form and creates the design with the fills', async () => {
    const t = template();
    const createProject = vi.fn(() => Promise.resolve('p1'));
    const api = createApiStub({
      listTemplates: vi.fn(() => Promise.resolve([summary(t)])),
      getTemplate: vi.fn(() => Promise.resolve({ id: 'tpl1', builtIn: true, document: t })),
    });
    const services = createTestServices({ api, persistence: createPersistenceStub({ createProject }) });
    renderWithServices(<Home />, services);
    const card = await screen.findByRole('button', { name: /^Use template: Promo$/ });
    fireEvent.click(card);
    const dialog = await screen.findByRole('dialog', { name: 'Use “Promo”' });
    expect(dialog).toBeTruthy();
    const headline = screen.getByLabelText(/Headline/) as HTMLInputElement;
    expect(headline.tagName).toBe('INPUT');
    expect(headline.placeholder).toBe('Your headline here');
    expect((screen.getByLabelText(/Subtitle/) as HTMLElement).tagName).toBe('TEXTAREA');
    // Required + max length are enforced before anything is created.
    fireEvent.click(screen.getByRole('button', { name: 'Create design' }));
    expect(await screen.findByText('Required')).toBeTruthy();
    expect(createProject).not.toHaveBeenCalled();
    fireEvent.change(headline, { target: { value: 'Way too long here' } });
    expect(screen.getByText('At most 12 characters')).toBeTruthy();
    expect(screen.getByText('17 / 12')).toBeTruthy();
    fireEvent.change(headline, { target: { value: 'Big sale' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use color #00ff00' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create design' }));
    });
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const [title, , accent] = t.template!.slots.map((s) => s.id);
    expect(createProject).toHaveBeenCalledWith({ template: t, fills: { [title!]: { text: 'Big sale' }, [accent!]: { color: '#00ff00' } } });
  });

  it('"Use as is" creates the design with the template placeholders', async () => {
    const t = template();
    const createProject = vi.fn(() => Promise.resolve('p1'));
    const api = createApiStub({
      listTemplates: vi.fn(() => Promise.resolve([summary(t)])),
      getTemplate: vi.fn(() => Promise.resolve({ id: 'tpl1', builtIn: true, document: t })),
    });
    renderWithServices(<Home />, createTestServices({ api, persistence: createPersistenceStub({ createProject }) }));
    fireEvent.click(await screen.findByRole('button', { name: /^Use template: Promo$/ }));
    await screen.findByRole('dialog', { name: 'Use “Promo”' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use as is' }));
    });
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ template: t, fills: {} }));
  });

  it('templates without slots skip the form', async () => {
    const t = { ...template(), template: { category: null, slots: [] } };
    const createProject = vi.fn(() => Promise.resolve('p1'));
    const api = createApiStub({
      listTemplates: vi.fn(() => Promise.resolve([summary(t)])),
      getTemplate: vi.fn(() => Promise.resolve({ id: 'tpl1', builtIn: true, document: t })),
    });
    renderWithServices(<TemplatesPanel />, createTestServices({ api, persistence: createPersistenceStub({ createProject }) }));
    await screen.findAllByRole('button', { name: /Promo/ });
    // "Use in a new design" from the card menu.
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Promo' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use in a new design' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ template: t, fills: {} }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
