import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, type PlakatDocument } from '@plakat/schema';
import { createEditorStore } from '../store/editor-store.ts';
import { ApiError, type ApiClient } from './client.ts';
import { createPersistence } from './persistence.ts';

function fakeClient(overrides: Partial<ApiClient> = {}) {
  let version = 1;
  const saved: { doc: PlakatDocument; baseVersion: number | null }[] = [];
  const client = {
    saveProject: vi.fn(async (id: string, doc: PlakatDocument, baseVersion: number | null) => {
      saved.push({ doc, baseVersion });
      version += 1;
      return { id, version, updatedAt: `t${version}` };
    }),
    createProject: vi.fn(async (doc: PlakatDocument) => ({ id: 'new-project', document: doc, version: 1, updatedAt: 't1' })),
    getProject: vi.fn(async (id: string) => ({ id, document: createDocument(), version: 7, updatedAt: 't7' })),
    getTemplate: vi.fn(async (id: string) => ({ id, document: createDocument('instagram-post', { kind: 'template' }), builtIn: true })),
    updateTemplate: vi.fn(async (id: string) => ({ id })),
    createTemplate: vi.fn(async () => ({ id: 'tpl1' })),
    uploadProjectThumbnail: vi.fn(async () => ({ thumbnailUrl: '/t.png' })),
    uploadTemplateThumbnail: vi.fn(async () => ({ thumbnailUrl: '/t.png' })),
    ...overrides,
  } as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;
  return { client, saved };
}

function setup(overrides: Partial<ApiClient> = {}, opts: Parameters<typeof createPersistence>[0] = {}) {
  const store = createEditorStore();
  store.getState().actions.openDocument(createDocument(), { projectId: 'p1', version: 1 });
  const { client, saved } = fakeClient(overrides);
  const persistence = createPersistence({ store, client, ...opts });
  persistence.start();
  return { store, client, saved, persistence, a: store.getState().actions };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('autosave', () => {
  it('debounces commits into one PUT ~1 s after the last edit, with baseVersion', async () => {
    const { store, client, saved, a } = setup();
    a.addShape('rect');
    await vi.advanceTimersByTimeAsync(500);
    a.addShape('ellipse');
    await vi.advanceTimersByTimeAsync(900);
    expect(client.saveProject).not.toHaveBeenCalled();
    expect(store.getState().saveStatus).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(200);
    expect(client.saveProject).toHaveBeenCalledTimes(1);
    expect(saved[0]!.baseVersion).toBe(1);
    expect(saved[0]!.doc.pages[0]!.elements).toHaveLength(2);
    expect(store.getState()).toMatchObject({ saveStatus: 'saved', version: 2, lastSavedAt: 't2' });
    expect(store.getState().savedRevision).toBe(store.getState().docRevision);
    a.undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved[1]!.baseVersion).toBe(2);
  });

  it('a 409 sets conflict and pauses autosave until resolved', async () => {
    const saveProject = vi.fn(async () => {
      throw new ApiError(409, 'version_conflict', 'stale');
    });
    const { store, a, persistence, client } = setup({ saveProject } as never);
    a.addShape('rect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState()).toMatchObject({ saveStatus: 'conflict', saveError: 'stale' });
    a.addShape('rect');
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveProject).toHaveBeenCalledTimes(1);
    // overwrite: fetch latest version (7), then PUT with it
    saveProject.mockImplementationOnce((async (id: string, _d: unknown, base: number) => ({ id, version: base + 1, updatedAt: 'x' })) as never);
    await persistence.resolveConflict('overwrite');
    expect(client.getProject).toHaveBeenCalledWith('p1');
    expect(saveProject).toHaveBeenLastCalledWith('p1', expect.anything(), 7);
    expect(store.getState()).toMatchObject({ saveStatus: 'saved', version: 8 });
  });

  it('reload strategy discards local changes', async () => {
    const saveProject = vi.fn(async () => {
      throw new ApiError(409, 'version_conflict', 'stale');
    });
    const { store, a, persistence } = setup({ saveProject } as never);
    a.addShape('rect');
    await vi.advanceTimersByTimeAsync(1000);
    await persistence.resolveConflict('reload');
    expect(store.getState()).toMatchObject({ saveStatus: 'saved', version: 7 });
    expect(store.getState().document.pages[0]!.elements).toHaveLength(0);
  });

  it('retries failed saves with backoff', async () => {
    let fail = true;
    const saveProject = vi.fn(async (id: string) => {
      if (fail) throw new ApiError(0, 'network_error', 'offline');
      return { id, version: 2, updatedAt: 'x' };
    });
    const { store, a } = setup({ saveProject } as never, { retryBaseMs: 2000 });
    a.addShape('rect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().saveStatus).toBe('error');
    fail = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(store.getState().saveStatus).toBe('saved');
  });

  it('edits during an in-flight save trigger a follow-up save', async () => {
    let resolve!: () => void;
    const saveProject = vi.fn(
      (id: string) =>
        new Promise<{ id: string; version: number; updatedAt: string }>((r) => {
          resolve = () => r({ id, version: saveProject.mock.calls.length + 1, updatedAt: 'x' });
        }),
    );
    const { store, a } = setup({ saveProject } as never);
    a.addShape('rect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().saveStatus).toBe('saving');
    a.addShape('rect');
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().saveStatus).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(1000);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(store.getState().saveStatus).toBe('saved');
  });

  it('saveNow / flush save immediately; unsaved local docs are created on first save', async () => {
    const store = createEditorStore();
    const { client } = fakeClient();
    const p = createPersistence({ store, client });
    p.start();
    store.getState().actions.addText();
    expect(p.hasUnsavedChanges()).toBe(true);
    await p.flush();
    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ projectId: 'new-project', version: 1, saveStatus: 'saved' });
    store.getState().actions.addText();
    await p.saveNow();
    expect(client.saveProject).toHaveBeenCalledWith('new-project', expect.anything(), 1);
    p.stop();
  });

  it('uploads a thumbnail after a successful save', async () => {
    const thumb = vi.fn(async () => new Blob([new Uint8Array([1])], { type: 'image/png' }));
    const { a, client } = setup({}, { thumbnail: thumb, thumbnailDelayMs: 3000 });
    a.addShape('rect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(thumb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(thumb).toHaveBeenCalledTimes(1);
    expect(client.uploadProjectThumbnail).toHaveBeenCalledWith('p1', expect.any(Blob));
  });
});

describe('loading and creating', () => {
  it('loadProject / openTemplate / createProject from template', async () => {
    const { store, persistence, client } = setup();
    await persistence.loadProject('p9');
    expect(store.getState()).toMatchObject({ projectId: 'p9', version: 7, projectKind: 'project', canUndo: false });
    const r = await persistence.openTemplate('t1');
    expect(r.builtIn).toBe(true);
    expect(store.getState()).toMatchObject({ projectId: 't1', projectKind: 'template', saveStatus: 'readonly' });
    const id = await persistence.createProject({ templateId: 't1', title: 'From template' });
    expect(id).toBe('new-project');
    const created = (client.createProject as ReturnType<typeof vi.fn>).mock.calls[0]![0] as PlakatDocument;
    expect(created).toMatchObject({ kind: 'design', template: null, meta: { title: 'From template', sourceTemplateId: expect.any(String) } });
    expect(store.getState()).toMatchObject({ projectId: 'new-project', projectKind: 'project', saveStatus: 'saved' });
  });

  it('createProject from a preset and saveAsTemplate', async () => {
    const { store, persistence, client } = setup();
    await persistence.createProject({ preset: 'youtube-thumbnail', title: 'Video' });
    expect(store.getState().document.size.width).toBe(1280);
    const t = store.getState().actions.addText();
    const r = await persistence.saveAsTemplate({ slots: [t], title: 'My template', category: 'video' });
    expect(r.id).toBe('tpl1');
    expect(r.document).toMatchObject({ kind: 'template', meta: { title: 'My template' }, template: { category: 'video' } });
    expect(r.document.template!.slots).toHaveLength(1);
    expect((client.createTemplate as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(r.document);
    expect(store.getState().document.kind).toBe('design');
  });

  it('templates save via PUT /api/templates/:id', async () => {
    const store = createEditorStore();
    const { client } = fakeClient();
    store.getState().actions.openDocument(createDocument('instagram-post', { kind: 'template' }), { projectId: 'tp', projectKind: 'template' });
    const p = createPersistence({ store, client });
    p.start();
    store.getState().actions.addText();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.updateTemplate).toHaveBeenCalledWith('tp', expect.objectContaining({ kind: 'template' }));
    expect(store.getState().saveStatus).toBe('saved');
  });
});
