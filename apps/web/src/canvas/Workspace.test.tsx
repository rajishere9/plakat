// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { RenderEnv } from '@plakat/renderer';
import { createDocument, createShapeElement, createTextElement, type PlakatDocument, type TextElement } from '@plakat/schema';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { detectPlatform } from '../lib/shortcuts.ts';
import { createEditorStore, type EditorStore } from '../store/editor-store.ts';
import type { WorkspaceController } from './controller.ts';
import { thumbnailScale } from './render-env.ts';
import { LIVE_COMMIT_MS, wordAt } from './TextEditor.tsx';
import { Workspace } from './Workspace.tsx';

const env: RenderEnv = {
  kind: 'test',
  async loadImage() {
    throw new Error('no images in this test');
  },
  async loadFonts() {},
};

function doc(): PlakatDocument {
  const d = createDocument({ width: 600, height: 400, presetId: null, physical: null });
  d.pages[0]!.background.color = '#ffffff';
  d.pages[0]!.elements = [
    createTextElement({ id: 't1', x: 50, y: 50, width: 300, height: 50, content: 'Hello', fontSize: 32 }),
    createShapeElement('rect', { id: 'r1', x: 400, y: 200, width: 100, height: 100, fill: '#ff0000' }),
  ];
  return d;
}

// jsdom has no layout: give elements a viewport-sized box so the stage is not 1×1.
const sizeProps = ['clientWidth', 'clientHeight'] as const;
const originals = sizeProps.map((k) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, k));
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
});
afterAll(() => {
  sizeProps.forEach((k, i) => {
    const d = originals[i];
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
  });
});

const mod = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };

afterEach(() => {
  cleanup();
  delete window.__plakat;
});

async function mount(extra: Partial<Parameters<typeof Workspace>[0]> = {}) {
  const store: EditorStore = createEditorStore({ document: doc() });
  let controller: WorkspaceController | null = null;
  const utils = render(<Workspace store={store} env={env} onController={(c) => (controller = c)} {...extra} />);
  await act(async () => {
    await window.__plakat!.ready();
  });
  return { store, utils, controller: controller! };
}

describe('<Workspace>', () => {
  it('mounts the stage and exposes window.__plakat', async () => {
    const { store, utils, controller } = await mount();
    expect(utils.container.querySelector('[data-plakat-workspace]')).not.toBeNull();
    expect(utils.container.querySelector('[data-plakat-stage] canvas')).not.toBeNull();
    const hook = window.__plakat!;
    expect(hook.store).toBe(store);
    expect(hook.controller).toBe(controller);
    expect(hook.getDocument()).toBe(store.getState().document);
    const pageId = store.getState().document.pages[0]!.id;
    const png = await hook.snapshotContentLayer(pageId, 2);
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // IHDR width/height = 1200×800
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(800);
    expect(typeof (await hook.snapshotContentLayerBase64(pageId, 1))).toBe('string');
  });

  it('removes the hook and destroys the stage on unmount', async () => {
    const { utils } = await mount();
    utils.unmount();
    expect(window.__plakat).toBeUndefined();
  });

  it('inline text editing: Mod+Enter commits, the overlay sits over the text', async () => {
    const { store } = await mount();
    act(() => store.getState().actions.startTextEditing('t1'));
    const ta = document.querySelector('textarea[data-plakat-text-editor]') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe('Hello');
    expect(ta.style.fontSize).toBe('32px');
    expect(ta.style.transform).toMatch(/^matrix\(/);
    fireEvent.change(ta, { target: { value: 'Hello\nworld' } });
    fireEvent.keyDown(ta, { key: 'Enter', ...mod });
    expect(store.getState().textEditingId).toBeNull();
    const t1 = store.getState().document.pages[0]!.elements[0] as TextElement;
    expect(t1.content).toBe('Hello\nworld');
    expect(t1.height).toBeGreaterThan(50); // auto-grown
    expect(document.querySelector('textarea[data-plakat-text-editor]')).toBeNull();
  });

  it('inline text editing: Escape cancels', async () => {
    const { store } = await mount();
    act(() => store.getState().actions.startTextEditing('t1'));
    const ta = document.querySelector('textarea[data-plakat-text-editor]') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'nope' } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(store.getState().textEditingId).toBeNull();
    expect((store.getState().document.pages[0]!.elements[0] as TextElement).content).toBe('Hello');
  });

  it('inline text editing commits the draft while typing (one undo step) and before unload', async () => {
    const { store } = await mount();
    act(() => store.getState().actions.startTextEditing('t1'));
    const ta = document.querySelector('textarea[data-plakat-text-editor]') as HTMLTextAreaElement;
    const content = () => (store.getState().document.pages[0]!.elements[0] as TextElement).content;
    vi.useFakeTimers();
    try {
      fireEvent.change(ta, { target: { value: 'Important' } });
      expect(content()).toBe('Hello');
      act(() => void vi.advanceTimersByTime(LIVE_COMMIT_MS));
      expect(content()).toBe('Important');
      expect(store.getState().textEditingId).toBe('t1');
      fireEvent.change(ta, { target: { value: 'Important headline' } });
      act(() => void vi.advanceTimersByTime(LIVE_COMMIT_MS));
      expect(content()).toBe('Important headline');
    } finally {
      vi.useRealTimers();
    }
    // Reload/close before the debounce fires: beforeunload commits the draft first.
    fireEvent.change(ta, { target: { value: 'Important headline!' } });
    window.dispatchEvent(new Event('beforeunload'));
    expect(content()).toBe('Important headline!');
    act(() => store.getState().actions.stopTextEditing());
    act(() => void store.getState().actions.undo());
    expect(content()).toBe('Hello');
  });

  it('inline text editing: Escape reverts drafts that were already committed while typing', async () => {
    const { store } = await mount();
    act(() => store.getState().actions.startTextEditing('t1'));
    const ta = document.querySelector('textarea[data-plakat-text-editor]') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'Draft' } });
    window.dispatchEvent(new Event('pagehide'));
    expect((store.getState().document.pages[0]!.elements[0] as TextElement).content).toBe('Draft');
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(store.getState().textEditingId).toBeNull();
    expect((store.getState().document.pages[0]!.elements[0] as TextElement).content).toBe('Hello');
  });

  it('T / Enter select all; a double-click places the caret instead', async () => {
    const { store, controller } = await mount();
    act(() => store.getState().actions.startTextEditing('t1'));
    let ta = document.querySelector('textarea[data-plakat-text-editor]') as HTMLTextAreaElement;
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 5]);
    act(() => store.getState().actions.stopTextEditing());
    const p = controller.pageToScreenPoint(store.getState().document.pages[0]!.id, { x: 60, y: 60 })!;
    act(() => controller.doubleClick(p));
    ta = document.querySelector('textarea[data-plakat-text-editor]') as HTMLTextAreaElement;
    // jsdom cannot hit-test text: the caret goes to the end instead of selecting everything.
    expect(ta.selectionStart).toBe(ta.selectionEnd);
  });

  it('wordAt finds the word around a caret offset', () => {
    expect(wordAt('Fix one word', 5)).toEqual([4, 7]);
    expect(wordAt('Fix one word', 7)).toEqual([4, 7]);
    expect(wordAt('Fix  word', 4)).toBeNull();
    expect(wordAt("don't stop", 2)).toEqual([0, 5]);
  });

  it('ending the edit by selecting something else commits the text', async () => {
    const { store } = await mount();
    act(() => store.getState().actions.startTextEditing('t1'));
    const ta = document.querySelector('textarea[data-plakat-text-editor]') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'Changed' } });
    act(() => store.getState().actions.select(['r1']));
    expect((store.getState().document.pages[0]!.elements[0] as TextElement).content).toBe('Changed');
  });

  it('wires keyboard shortcuts on window (and respects focus in inputs)', async () => {
    const onSave = vi.fn();
    const { store } = await mount({ onSave });
    act(() => store.getState().actions.select(['r1']));
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(store.getState().document.pages[0]!.elements[1]!.x).toBe(401);
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ...mod });
    expect(onSave).toHaveBeenCalledTimes(1);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Delete', code: 'Delete' });
    expect(store.getState().document.pages[0]!.elements).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' });
    expect(store.getState().document.pages[0]!.elements).toHaveLength(1);
    // Enter on a selected text starts editing
    act(() => store.getState().actions.select(['t1']));
    fireEvent.keyDown(document.body, { key: 'Enter', code: 'Enter' });
    expect(store.getState().textEditingId).toBe('t1');
  });

  it('opens a context menu on right click and runs actions', async () => {
    const { store, controller, utils } = await mount();
    const p = controller.pageToScreenPoint(store.getState().document.pages[0]!.id, { x: 450, y: 250 })!;
    const host = utils.container.querySelector('[data-plakat-stage]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(host, { clientX: p.x, clientY: p.y, button: 2 });
    });
    expect(store.getState().selectedIds).toEqual(['r1']);
    const menu = document.querySelector('[data-plakat-context-menu]');
    expect(menu).not.toBeNull();
    const dup = menu!.querySelector('[data-action="duplicate"]') as HTMLButtonElement;
    act(() => dup.click());
    expect(store.getState().document.pages[0]!.elements).toHaveLength(3);
    expect(document.querySelector('[data-plakat-context-menu]')).toBeNull();
  });
});

describe('thumbnailScale', () => {
  it('fits the longest side into 480 px and never upscales', () => {
    expect(thumbnailScale({ width: 1080, height: 1920 })).toBeCloseTo(0.25, 9);
    expect(thumbnailScale({ width: 300, height: 200 })).toBe(1);
    expect(thumbnailScale({ width: 2000, height: 1000 }, 500)).toBe(0.25);
  });
});
