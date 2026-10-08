// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, serializeDocument } from '@plakat/schema';
import type { ProjectSummary } from '../api/index.ts';
import { Home } from './Home.tsx';
import { createApiStub, createPersistenceStub, createTestServices, renderWithServices } from './test-utils.tsx';
import { TopBar } from './TopBar.tsx';

afterEach(() => {
  cleanup();
  location.hash = '';
});

describe('Home', () => {
  it('creates a design from a preset and opens it', async () => {
    const persistence = createPersistenceStub({ createProject: vi.fn(() => Promise.resolve('proj_9')) });
    renderWithServices(<Home />, createTestServices({ persistence }));
    expect(screen.getByText('210 × 297 mm')).toBeTruthy();
    expect(screen.getByText('3.5 × 2 in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /A4 poster/ }));
    await waitFor(() => expect(location.hash).toBe('#/design/proj_9'));
    expect(persistence.createProject).toHaveBeenCalledWith({ preset: 'a4-poster' });
  });

  it('lists recent projects with rename and delete', async () => {
    const p: ProjectSummary = { id: 'p1', title: 'Spring sale', updatedAt: new Date().toISOString(), size: { width: 1080, height: 1080 }, pageCount: 2, thumbnailUrl: null };
    const doc = createDocument('instagram-post', { title: 'Spring sale' });
    const api = createApiStub({
      listProjects: vi.fn(() => Promise.resolve([p])),
      getProject: vi.fn(() => Promise.resolve({ id: 'p1', document: doc, version: 3, updatedAt: p.updatedAt })),
      saveProject: vi.fn(() => Promise.resolve({ id: 'p1', version: 4, updatedAt: p.updatedAt })),
      deleteProject: vi.fn(() => Promise.resolve()),
    });
    renderWithServices(<Home />, createTestServices({ api }));
    expect(await screen.findByRole('link', { name: 'Open Spring sale' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Spring sale' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Title' });
    fireEvent.change(input, { target: { value: 'Summer sale' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    });
    expect(api.saveProject).toHaveBeenCalledWith('p1', expect.objectContaining({ meta: expect.objectContaining({ title: 'Summer sale' }) }), 3);

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Spring sale' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    expect(api.deleteProject).toHaveBeenCalledWith('p1');
  });

  it('imports a design file as a new project and a template file into the library', async () => {
    const persistence = createPersistenceStub({ createProject: vi.fn(() => Promise.resolve('imp_1')) });
    const api = createApiStub({ importTemplate: vi.fn(() => Promise.resolve({ id: 't9' })) });
    renderWithServices(<Home />, createTestServices({ persistence, api }));
    const input = screen.getByLabelText('Choose a .plakat.json file to import') as HTMLInputElement;

    const design = createDocument('instagram-post', { title: 'Imported' });
    fireEvent.change(input, { target: { files: [new File([serializeDocument(design)], 'imported.plakat.json', { type: 'application/json' })] } });
    await waitFor(() => expect(persistence.createProject).toHaveBeenCalled());
    expect(vi.mocked(persistence.createProject).mock.calls[0]![0]).toMatchObject({ document: { meta: { title: 'Imported' } } });

    const tpl = createDocument('instagram-post', { title: 'Tpl', kind: 'template' });
    tpl.template = { category: null, slots: [] };
    const text = serializeDocument(tpl);
    fireEvent.change(input, { target: { files: [new File([text], 'tpl.plakat.json')] } });
    await waitFor(() => expect(api.importTemplate).toHaveBeenCalledWith(text));
  });
});

describe('TopBar', () => {
  const noop = () => {};
  it('wires undo/redo, title and zoom to the store', () => {
    const services = createTestServices();
    renderWithServices(<TopBar onHome={noop} onExport={noop} onSaveAsTemplate={noop} onDownloadFile={noop} onShortcuts={noop} />, services);
    const undo = screen.getByRole('button', { name: /^Undo/ }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    const title = screen.getByRole('textbox', { name: 'Design title' });
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Poster' } });
    fireEvent.blur(title);
    expect(services.store.getState().document.meta.title).toBe('Poster');
    expect((screen.getByRole('button', { name: /^Undo/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
    expect(services.store.getState().document.meta.title).not.toBe('Poster');

    const zoom = screen.getByRole('textbox', { name: 'Zoom level (percent)' });
    fireEvent.focus(zoom);
    fireEvent.change(zoom, { target: { value: '150' } });
    fireEvent.blur(zoom);
    expect(services.store.getState().zoom).toBeCloseTo(1.5);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(services.store.getState().zoom).toBeGreaterThan(1.5);
  });

  it('offers conflict resolution from the save status', async () => {
    const services = createTestServices();
    act(() => services.store.getState().actions.setPersistenceState({ projectId: 'p1', saveStatus: 'conflict' }));
    renderWithServices(<TopBar onHome={noop} onExport={noop} onSaveAsTemplate={noop} onDownloadFile={noop} onShortcuts={noop} />, services);
    fireEvent.click(screen.getByRole('button', { name: /Edited elsewhere/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Save mine as a copy' }));
    expect(services.persistence.resolveConflict).toHaveBeenCalledWith('saveAsCopy');
  });

  it('opens the share menu with export and template actions', async () => {
    const onExport = vi.fn();
    const onSaveAsTemplate = vi.fn();
    renderWithServices(<TopBar onHome={noop} onExport={onExport} onSaveAsTemplate={onSaveAsTemplate} onDownloadFile={noop} onShortcuts={noop} />, createTestServices());
    const share = screen.getByRole('button', { name: /Share/ });
    fireEvent.keyDown(share, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download PNG, JPG or PDF/ }));
    expect(onExport).toHaveBeenCalled();
    fireEvent.click(share);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Save as template/ }));
    expect(onSaveAsTemplate).toHaveBeenCalled();
  });
});
