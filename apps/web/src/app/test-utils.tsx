/**
 * Test helpers for UI tests (imported by *.test.tsx only): renders a component inside a
 * ServicesProvider with an isolated editor store, a stubbed API client and persistence.
 */
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { createDocument, type PageSize, type PlakatDocument, type PlakatElement, type PresetId } from '@plakat/schema';
import type { RenderEnv } from '@plakat/renderer';
import type { ApiClient, Persistence } from '../api/index.ts';
import { createEditorStore, type EditorStore } from '../store/index.ts';
import { ServicesProvider, type AppServices } from './services.tsx';

export type ApiStub = { [K in keyof ApiClient]: ApiClient[K] extends (...args: infer A) => infer R ? ReturnType<typeof vi.fn<(...args: A) => R>> : ApiClient[K] };

/** Every API method as a vi.fn that rejects unless overridden. */
export function createApiStub(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const reject = () => Promise.reject(new Error('not stubbed'));
  const base: Record<string, unknown> = {
    baseUrl: '',
    health: vi.fn(reject),
    listProjects: vi.fn(() => Promise.resolve([])),
    createProject: vi.fn(reject),
    getProject: vi.fn(reject),
    saveProject: vi.fn(reject),
    deleteProject: vi.fn(reject),
    uploadProjectThumbnail: vi.fn(reject),
    listTemplates: vi.fn(() => Promise.resolve([])),
    getTemplate: vi.fn(reject),
    createTemplate: vi.fn(reject),
    updateTemplate: vi.fn(reject),
    deleteTemplate: vi.fn(reject),
    templateFileUrl: vi.fn((id: string) => `/api/templates/${id}/file`),
    downloadTemplateFile: vi.fn(reject),
    importTemplate: vi.fn(reject),
    uploadTemplateThumbnail: vi.fn(reject),
    listBrandKits: vi.fn(() => Promise.resolve([])),
    createBrandKit: vi.fn(reject),
    getBrandKit: vi.fn(reject),
    updateBrandKit: vi.fn((_id: string, k: unknown) => Promise.resolve(k)),
    deleteBrandKit: vi.fn(reject),
    upload: vi.fn(reject),
    listAssetProviders: vi.fn(() => Promise.resolve([])),
    searchAssets: vi.fn(reject),
    importAsset: vi.fn(reject),
  };
  return { ...base, ...overrides } as unknown as ApiClient;
}

export function createPersistenceStub(overrides: Partial<Persistence> = {}): Persistence {
  return {
    start: vi.fn(() => () => {}),
    stop: vi.fn(),
    saveNow: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
    hasUnsavedChanges: vi.fn(() => false),
    loadProject: vi.fn(() => Promise.resolve()),
    openTemplate: vi.fn(() => Promise.resolve({ builtIn: false })),
    createProject: vi.fn(() => Promise.resolve('p1')),
    saveAsTemplate: vi.fn(() => Promise.reject(new Error('not stubbed'))),
    resolveConflict: vi.fn(() => Promise.resolve()),
    setThumbnailProducer: vi.fn(),
    uploadThumbnailNow: vi.fn(() => Promise.resolve()),
    installBeforeUnload: vi.fn(() => () => {}),
    ...overrides,
  };
}

export function docWith(elements: PlakatElement[], size: PresetId | PageSize = { width: 1000, height: 1000, presetId: null, physical: null }, pageCount = 1): PlakatDocument {
  const doc = createDocument(size, { pageCount });
  doc.pages[0]!.elements = elements;
  return doc;
}

export interface TestServices extends AppServices {
  store: EditorStore;
}

export function createTestServices(opts: { document?: PlakatDocument; api?: ApiClient; persistence?: Persistence } = {}): TestServices {
  const store = createEditorStore(opts.document ? { document: opts.document } : {});
  return {
    store,
    api: opts.api ?? createApiStub(),
    persistence: opts.persistence ?? createPersistenceStub(),
    getRenderEnv: () => ({ kind: 'test' }) as unknown as RenderEnv,
    renderPreview: vi.fn(() => Promise.reject(new Error('no rendering in tests'))),
  };
}

export function renderWithServices(ui: ReactElement, services: AppServices = createTestServices()): RenderResult & { services: AppServices } {
  const result = render(<ServicesProvider value={services}>{ui}</ServicesProvider>);
  return { ...result, services };
}
