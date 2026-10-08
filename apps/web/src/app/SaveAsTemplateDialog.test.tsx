// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageElement, createShapeElement, createTextElement, saveAsTemplate, type PlakatDocument } from '@plakat/schema';
import { buildSlotSpecs, initialSlotRows, SaveAsTemplateDialog, type SaveAsTemplateInput } from './SaveAsTemplateDialog.tsx';
import { createPersistenceStub, createTestServices, docWith, renderWithServices } from './test-utils.tsx';

afterEach(cleanup);

function designDoc(): PlakatDocument {
  const asset = { type: 'image', mimeType: 'image/png', width: 100, height: 100, src: '/uploads/x.png', name: 'x', source: null } as const;
  const doc = docWith(
    [
      createShapeElement('rect', { id: 'bg', name: 'Background', fill: '#112233' }),
      createImageElement('as_1', asset, { id: 'photo', name: 'Photo' }),
      createTextElement({ id: 'title', content: 'Big title' }),
      createTextElement({ id: 'locked', content: 'Fine print', locked: true }),
    ],
    'instagram-post',
  );
  doc.assets['as_1'] = asset;
  doc.meta.title = 'Launch post';
  return doc;
}

describe('slot rows', () => {
  it('pre-checks unlocked text and images (not shapes or locked elements), topmost first', () => {
    const rows = initialSlotRows(designDoc());
    expect(rows.map((r) => [r.elementId, r.kind, r.checked])).toEqual([
      ['locked', 'text', false],
      ['title', 'text', true],
      ['photo', 'image', true],
      ['bg', 'color', false],
    ]);
    expect(rows.find((r) => r.elementId === 'title')!.label).toBe('Big title');
  });

  it('builds SlotSpecs accepted by schema saveAsTemplate', () => {
    const doc = designDoc();
    const rows = initialSlotRows(doc).map((r) => (r.elementId === 'bg' ? { ...r, checked: true } : r.elementId === 'title' ? { ...r, maxLength: 40, required: true } : r));
    const specs = buildSlotSpecs(rows);
    expect(specs).toEqual([
      { kind: 'text', targets: ['title'], label: 'Big title', required: true, maxLength: 40 },
      { kind: 'image', targets: ['photo'], label: 'Photo', required: false },
      { kind: 'color', targets: ['bg'], label: 'Background', required: false, property: 'fill' },
    ]);
    const tpl = saveAsTemplate(doc, specs, { title: 'T', category: 'instagram-post' });
    expect(tpl.kind).toBe('template');
    expect(tpl.template!.slots.map((s) => s.kind)).toEqual(['text', 'image', 'color']);
  });
});

describe('SaveAsTemplateDialog', () => {
  it('lets the user choose slots, labels, limits and category, then saves the specs', async () => {
    const onSave = vi.fn<(i: SaveAsTemplateInput) => Promise<void>>(() => Promise.resolve());
    const doc = designDoc();
    const services = createTestServices({ document: doc, persistence: createPersistenceStub() });
    const onClose = vi.fn();
    renderWithServices(<SaveAsTemplateDialog open onClose={onClose} document={doc} onSave={onSave} />, services);

    expect(screen.getByText('2 editable elements')).toBeTruthy();
    // Make the background color editable, untick the photo, rename + limit the title.
    const bgRow = screen.getByTestId('slot-row-bg');
    fireEvent.click(within(bgRow).getByRole('checkbox', { name: /Editable: Background/ }));
    fireEvent.click(within(screen.getByTestId('slot-row-photo')).getByRole('checkbox', { name: /Editable: Photo/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Slot label for Big title' }), { target: { value: 'Headline' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Maximum characters for Big title' }), { target: { value: '32' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Required: Big title' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: 'Launch template' } });
    expect((screen.getByRole('combobox', { name: 'Category' }) as HTMLInputElement).value).toBe('instagram-post');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to templates' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      title: 'Launch template',
      category: 'instagram-post',
      slots: [
        { kind: 'text', targets: ['title'], label: 'Headline', required: true, maxLength: 32 },
        { kind: 'color', targets: ['bg'], label: 'Background', required: false, property: 'fill' },
      ],
    });
  });

  it('refuses a max length shorter than the placeholder text', async () => {
    const onSave = vi.fn<(i: SaveAsTemplateInput) => Promise<void>>(() => Promise.resolve());
    const doc = designDoc();
    renderWithServices(<SaveAsTemplateDialog open onClose={() => {}} document={doc} onSave={onSave} />, createTestServices({ document: doc }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Maximum characters for Big title' }), { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to templates' }));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/allows at most 2\. Shorten the text or raise the limit\./)).toBeTruthy();
  });

  it('defaults to persistence.saveAsTemplate and shows errors inline', async () => {
    const doc = designDoc();
    const persistence = createPersistenceStub({ saveAsTemplate: vi.fn(() => Promise.reject(new Error('Server says no'))) });
    const services = createTestServices({ document: doc, persistence });
    renderWithServices(<SaveAsTemplateDialog open onClose={() => {}} document={doc} />, services);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to templates' }));
    });
    expect(persistence.saveAsTemplate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Launch post', slots: expect.any(Array) }));
    expect(await screen.findByText('Server says no')).toBeTruthy();
  });

  it('pre-checks existing slots when the document already is a template', () => {
    const doc = designDoc();
    doc.kind = 'template';
    doc.template = { category: 'poster', slots: [{ id: 'slot_1', kind: 'color', label: 'Brand color', description: '', required: true, targets: ['bg'], property: 'fill', palette: [] }] };
    const rows = initialSlotRows(doc);
    expect(rows.filter((r) => r.checked).map((r) => r.elementId)).toEqual(['bg']);
    expect(rows.find((r) => r.elementId === 'bg')).toMatchObject({ label: 'Brand color', required: true });
  });
});
