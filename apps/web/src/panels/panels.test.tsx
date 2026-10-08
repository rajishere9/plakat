// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrandKit, createDocument, createTextElement, setBrandFont, type ShapeElement, type TextElement } from '@plakat/schema';
import type { AssetProviderInfo, TemplateSummary } from '../api/index.ts';
import { createApiStub, createTestServices, docWith, renderWithServices } from '../app/test-utils.tsx';
import { BrandPanel } from './BrandPanel.tsx';
import { ElementsPanel } from './ElementsPanel.tsx';
import { PagesPanel } from './PagesPanel.tsx';
import { PhotosPanel } from './PhotosPanel.tsx';
import { TemplatesPanel } from './TemplatesPanel.tsx';
import { TextPanel } from './TextPanel.tsx';
import { UploadsPanel } from './UploadsPanel.tsx';

afterEach(cleanup);

const els = (s: ReturnType<typeof createTestServices>) => s.store.getState().document.pages.flatMap((p) => p.elements);

describe('ElementsPanel', () => {
  it('adds shapes centered on the page', () => {
    const services = createTestServices({ document: docWith([]) });
    renderWithServices(<ElementsPanel />, services);
    fireEvent.click(screen.getByRole('button', { name: 'Add rounded rectangle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add hexagon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add dashed line' }));
    const [rr, hex, line] = els(services) as ShapeElement[];
    expect(rr).toMatchObject({ shape: 'rect', cornerRadius: 48 });
    expect(rr!.x + rr!.width / 2).toBeCloseTo(500);
    expect(hex).toMatchObject({ shape: 'polygon', sides: 6 });
    expect(line!.shape).toBe('line');
    expect(line!.dash.length).toBe(2);
    expect(services.store.getState().selectedIds).toEqual([line!.id]);
  });
});

describe('TextPanel', () => {
  it('adds presets, using the brand font for the role', () => {
    const services = createTestServices({ document: docWith([]) });
    const kit = setBrandFont(createBrandKit('Acme'), { role: 'heading', family: 'Montserrat', weight: 800 }).kit;
    act(() => services.store.getState().actions.setBrandKits([kit]));
    renderWithServices(<TextPanel />, services);
    expect(screen.getByText('Brand fonts · Acme')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a heading' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a little bit of body text' }));
    const [h, b] = els(services) as TextElement[];
    expect(h).toMatchObject({ fontFamily: 'Montserrat', fontWeight: 800 });
    expect(b!.fontFamily).toBe('Inter');
    expect(b!.fontSize).toBeLessThan(h!.fontSize);
  });
});

describe('PagesPanel', () => {
  it('adds, duplicates, deletes and recolors pages', async () => {
    const services = createTestServices({ document: createDocument('instagram-post') });
    renderWithServices(<PagesPanel />, services);
    const pages = () => services.store.getState().document.pages;
    fireEvent.click(screen.getByRole('button', { name: 'Add page' }));
    expect(pages()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Page 2' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Page 1' }));
    expect(services.store.getState().activePageId).toBe(pages()[0]!.id);
    // Keyboard reorder.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Page 1' }), { key: 'ArrowDown', altKey: true });
    expect(pages()[1]!.id).toBe(services.store.getState().activePageId);
    // Menu: duplicate + delete.
    fireEvent.click(screen.getByRole('button', { name: 'Page 1 actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate page' }));
    expect(pages()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Page 3 actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete page' }));
    expect(pages()).toHaveLength(2);
    // Background color through the hex field.
    fireEvent.click(screen.getByRole('button', { name: /Page background color/ }));
    const hex = screen.getByRole('textbox', { name: 'Page background color hex value' });
    fireEvent.change(hex, { target: { value: '#abc' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    const active = pages().find((p) => p.id === services.store.getState().activePageId)!;
    expect(active.background.color).toBe('#aabbcc');
  });
});

describe('TemplatesPanel', () => {
  const summary: TemplateSummary = { id: 'tpl_1', title: 'Quote card', category: 'instagram-post', size: { width: 1080, height: 1080 }, pageCount: 1, slotCount: 1, thumbnailUrl: '/thumb.png', builtIn: true };

  it('applies a template to the empty current page (undoable)', async () => {
    const template = createDocument('instagram-post', { kind: 'template', title: 'Quote card' });
    template.template = { category: 'instagram-post', slots: [] };
    template.pages[0]!.elements = [createTextElement({ id: 'q', content: 'Quote' })];
    const api = createApiStub({
      listTemplates: vi.fn(() => Promise.resolve([summary])),
      getTemplate: vi.fn(() => Promise.resolve({ id: 'tpl_1', document: template, builtIn: true })),
    });
    const services = createTestServices({ document: createDocument('instagram-post'), api });
    renderWithServices(<TemplatesPanel />, services);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply template: Quote card' }));
    await waitFor(() => expect(els(services)).toHaveLength(1));
    expect((els(services)[0] as TextElement).content).toBe('Quote');
    expect(services.store.getState().document.pages).toHaveLength(1);
    act(() => void services.store.getState().actions.undo());
    expect(els(services)).toHaveLength(0);
  });

  it('shows category chips and an error state with retry', async () => {
    const listTemplates = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([summary]);
    const services = createTestServices({ api: createApiStub({ listTemplates }) });
    renderWithServices(<TemplatesPanel />, services);
    expect(await screen.findByText('offline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Apply template: Quote card' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Instagram post' })).toBeTruthy();
  });
});

describe('PhotosPanel', () => {
  const provider: AssetProviderInfo = { id: 'openverse', name: 'Openverse', description: 'Free photos', requiresKey: false, configured: true, homepage: 'https://openverse.org', licenseNote: 'Check each license.' };

  it('shows a configure-key notice when the provider needs a key', async () => {
    const api = createApiStub({ listAssetProviders: vi.fn(() => Promise.resolve([{ ...provider, requiresKey: true, configured: false }])) });
    renderWithServices(<PhotosPanel />, createTestServices({ api }));
    expect(await screen.findByText(/needs an API key/)).toBeTruthy();
  });

  it('searches (debounced), shows attribution and imports on click', async () => {
    const item = { id: 'img1', title: 'Latte', thumbUrl: 'https://x/t.jpg', previewUrl: 'https://x/p.jpg', width: 400, height: 300, creator: 'Ann', creatorUrl: null, license: 'CC BY 2.0', licenseUrl: null, pageUrl: 'https://x/page' };
    const api = createApiStub({
      listAssetProviders: vi.fn(() => Promise.resolve([provider])),
      searchAssets: vi.fn(() => Promise.resolve({ items: [item], page: 1, hasMore: false })),
      importAsset: vi.fn(() =>
        Promise.resolve({
          src: '/uploads/abc.jpg',
          mimeType: 'image/jpeg',
          width: 400,
          height: 300,
          byteSize: 10,
          sha256: 'abc',
          attribution: { title: 'Latte', creator: 'Ann', creatorUrl: null, license: 'CC BY 2.0', licenseUrl: null, pageUrl: 'https://x/page', provider: 'openverse' },
        }),
      ),
    });
    const services = createTestServices({ document: docWith([]), api });
    renderWithServices(<PhotosPanel />, services);
    fireEvent.click(await screen.findByRole('button', { name: 'Coffee' }));
    const btn = await screen.findByRole('button', { name: 'Insert photo: “Latte” · by Ann · CC BY 2.0' }, { timeout: 2000 });
    expect(api.searchAssets).toHaveBeenCalledWith('openverse', { q: 'Coffee', page: 1, perPage: 20 });
    fireEvent.click(btn);
    await waitFor(() => expect(els(services)).toHaveLength(1));
    const asset = Object.values(services.store.getState().document.assets)[0]!;
    expect(asset.src).toBe('/uploads/abc.jpg');
    expect(asset.source).toMatchObject({ provider: 'openverse', author: 'Ann', license: 'CC BY 2.0' });
  });
});

describe('UploadsPanel', () => {
  it('rejects unsupported files and lists design images for insertion', async () => {
    const asset = { type: 'image', mimeType: 'image/png', width: 10, height: 10, src: '/uploads/a.png', name: 'logo', source: null } as const;
    const doc = docWith([]);
    doc.assets['as_a'] = asset;
    const services = createTestServices({ document: doc });
    renderWithServices(<UploadsPanel />, services);
    fireEvent.click(screen.getByRole('button', { name: 'Insert logo' }));
    expect(els(services)).toHaveLength(1);
    const input = screen.getByLabelText('Choose images to upload') as HTMLInputElement;
    const file = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(services.api.upload).not.toHaveBeenCalled();
  });
});

describe('BrandPanel', () => {
  it('creates a kit, adds a color and applies the brand to the design', async () => {
    const created = createBrandKit('My brand');
    const api = createApiStub({ createBrandKit: vi.fn(() => Promise.resolve(created)) });
    const services = createTestServices({ document: docWith([createTextElement({ id: 't', fill: '#000000', content: 'x' })]), api });
    renderWithServices(<BrandPanel />, services);
    fireEvent.click(screen.getByRole('button', { name: 'Create brand kit' }));
    expect(await screen.findByRole('textbox', { name: 'Brand kit name' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add brand color' }));
    const hex = screen.getByRole('textbox', { name: 'Hex value' });
    fireEvent.change(hex, { target: { value: '#ff0066' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add color' }));
    expect(services.store.getState().brandKits[0]!.colors.map((c) => c.value)).toEqual(['#ff0066']);
    fireEvent.click(screen.getByRole('button', { name: 'Apply brand to design' }));
    // The most-used document color (ties: first seen, the page background) maps to brand color 1.
    expect(services.store.getState().document.pages[0]!.background.color).toBe('#ff0066');
    expect(services.store.getState().canUndo).toBe(true);
  });
});
