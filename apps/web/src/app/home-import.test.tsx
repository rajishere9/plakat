// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, serializeDocument, type PlakatDocument } from '@plakat/schema';
import { createApiStub, createPersistenceStub, createTestServices, renderWithServices } from './test-utils.tsx';
import { Home } from './Home.tsx';
import { toastStore } from './toasts.tsx';

afterEach(cleanup);
beforeEach(() => toastStore.setState({ toasts: [] }));

function setup() {
  const createProject = vi.fn((_s: { document: PlakatDocument }) => Promise.resolve('p1'));
  const importTemplate = vi.fn(() => Promise.resolve({ id: 't1' }));
  const api = createApiStub({ importTemplate });
  renderWithServices(<Home />, createTestServices({ api, persistence: createPersistenceStub({ createProject: createProject as never }) }));
  const input = screen.getByLabelText('Choose a .plakat.json file to import') as HTMLInputElement;
  const pick = (name: string, text: string) => fireEvent.change(input, { target: { files: [new File([text], name, { type: 'application/json' })] } });
  return { createProject, importTemplate, pick };
}

const lastToast = () => toastStore.getState().toasts.at(-1);

describe('Home: import file', () => {
  it('imports a current design file as a new project', async () => {
    const { createProject, pick } = setup();
    const doc = createDocument('instagram-post', { title: 'Mine' });
    pick('mine.plakat.json', serializeDocument(doc));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    expect(createProject.mock.calls[0]![0].document).toEqual(JSON.parse(serializeDocument(doc)));
  });

  it('migrates a v0 (pre-versioning) design file', async () => {
    const { createProject, pick } = setup();
    pick('old.json', JSON.stringify({ id: 'doc_loose', width: 1280, height: 720, pages: [{ id: 'pg_1', elements: [] }] }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const doc = createProject.mock.calls[0]![0].document;
    expect(doc).toMatchObject({ schemaVersion: 1, size: { width: 1280, height: 720 } });
  });

  it('refuses a file from a newer Plakat with an actionable message', async () => {
    const { createProject, pick } = setup();
    const future = { ...JSON.parse(serializeDocument(createDocument())), schemaVersion: 2 };
    pick('future.plakat.json', JSON.stringify(future));
    await waitFor(() => expect(lastToast()?.kind).toBe('error'));
    expect(lastToast()!.message).toBe('Could not import future.plakat.json');
    expect(lastToast()!.detail).toMatch(/schemaVersion 2.*supports up to 1.*Upgrade Plakat/);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('sends template files to the template library (raw text)', async () => {
    const { createProject, importTemplate, pick } = setup();
    const text = serializeDocument(createDocument('instagram-post', { kind: 'template', title: 'Tpl' }));
    pick('tpl.plakat.json', text);
    await waitFor(() => expect(importTemplate).toHaveBeenCalledWith(text));
    expect(lastToast()!.message).toBe('Imported template “Tpl”');
    expect(createProject).not.toHaveBeenCalled();
  });

  it('reports invalid JSON', async () => {
    const { pick } = setup();
    pick('broken.json', '{nope');
    await waitFor(() => expect(lastToast()?.kind).toBe('error'));
    expect(lastToast()!.detail).toMatch(/Not valid JSON/);
  });
});
