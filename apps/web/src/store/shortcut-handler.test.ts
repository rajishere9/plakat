// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_MIME } from '../lib/clipboard.ts';
import { createClipboardEventHandlers, createShortcutHandler } from './shortcut-handler.ts';
import { el, makeStore, page0, rect, text } from './test-helpers.ts';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });

describe('createShortcutHandler', () => {
  it('runs store actions and preventDefaults', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const onSave = vi.fn();
    const handle = createShortcutHandler({ store, platform: 'other', onSave });
    store.getState().actions.select(['a']);
    const e = key({ key: 'ArrowRight', shiftKey: true });
    expect(handle(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(el(store, 'a').x).toBe(10);
    handle(key({ key: 'z', ctrlKey: true }));
    expect(el(store, 'a').x).toBe(0);
    handle(key({ key: 'd', ctrlKey: true }));
    expect(page0(store).elements).toHaveLength(2);
    handle(key({ key: 'Delete' }));
    expect(page0(store).elements).toHaveLength(1);
    handle(key({ key: 's', ctrlKey: true }));
    expect(onSave).toHaveBeenCalled();
    handle(key({ key: 't' }));
    expect(store.getState().textEditingId).not.toBeNull();
    handle(key({ key: 'Escape' }));
    expect(store.getState().textEditingId).toBeNull();
    handle(key({ key: '?', shiftKey: true }));
    expect(store.getState().shortcutsHelpOpen).toBe(true);
    handle(key({ key: '1', code: 'Digit1', ctrlKey: true }));
    expect(store.getState().zoom).toBe(1);
    handle(key({ key: '=', code: 'Equal', ctrlKey: true }));
    expect(store.getState().zoom).toBe(1.25);
  });

  it('ignores keys while typing in an input and leaves clipboard keys to native events when asked', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    store.getState().actions.select(['a']);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const handle = createShortcutHandler({ store, platform: 'other', nativeClipboard: true });
    const e = new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true, bubbles: true });
    input.addEventListener('keydown', (ev) => handle(ev));
    input.dispatchEvent(e);
    expect(page0(store).elements).toHaveLength(1);
    expect(e.defaultPrevented).toBe(false);
    expect(handle(key({ key: 'c', ctrlKey: true }))).toBe(false);
  });
});

describe('createClipboardEventHandlers', () => {
  it('writes the custom MIME on copy and pastes it back', () => {
    const { store } = makeStore([rect('a', 5, 5, 10, 10)]);
    store.getState().actions.select(['a']);
    const data = new Map<string, string>();
    const clipboardData = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? '', files: [] };
    const h = createClipboardEventHandlers({ store });
    const copy = { clipboardData, preventDefault: vi.fn(), target: document.body } as unknown as ClipboardEvent;
    h.onCopy(copy);
    expect(data.get(CLIPBOARD_MIME)).toContain('plakat.clipboard');
    expect(copy.preventDefault).toHaveBeenCalled();
    const paste = { clipboardData, preventDefault: vi.fn(), target: document.body } as unknown as ClipboardEvent;
    h.onPaste(paste);
    expect(page0(store).elements).toHaveLength(2);
    expect(page0(store).elements[1]).toMatchObject({ x: 21, y: 21 });
  });

  it('hands pasted image files to onPasteFiles', () => {
    const { store } = makeStore();
    const onPasteFiles = vi.fn();
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    const h = createClipboardEventHandlers({ store, onPasteFiles });
    h.onPaste({ clipboardData: { files: [file], getData: () => '' }, preventDefault: vi.fn(), target: document.body } as unknown as ClipboardEvent);
    expect(onPasteFiles).toHaveBeenCalledWith([file]);
  });

  const fakeData = (init: Record<string, string> = {}) => {
    const data = new Map<string, string>(Object.entries(init));
    return {
      data,
      clipboardData: {
        setData: (t: string, v: string) => data.set(t, v),
        getData: (t: string) => data.get(t) ?? '',
        get types() {
          return [...data.keys()];
        },
        files: [],
      },
    };
  };
  const ev = (clipboardData: unknown, target: EventTarget = document.body) => ({ clipboardData, preventDefault: vi.fn(), target }) as unknown as ClipboardEvent;

  it('never puts the JSON payload in text/plain', () => {
    const { store } = makeStore([rect('a', 5, 5, 10, 10), text('t', 0, 0, { content: 'Headline' } as never)]);
    const { data, clipboardData } = fakeData();
    const h = createClipboardEventHandlers({ store });
    store.getState().actions.select(['a']);
    h.onCopy(ev(clipboardData));
    expect(data.get('text/plain')).toBe('');
    expect(data.get(CLIPBOARD_MIME)).toContain('plakat.clipboard');
    store.getState().actions.select(['t']);
    h.onCopy(ev(clipboardData));
    expect(data.get('text/plain')).toBe('Headline');
    // Only the text/html fallback is left (custom MIME dropped): still pastes elements.
    data.delete(CLIPBOARD_MIME);
    h.onPaste(ev(clipboardData));
    expect(page0(store).elements.filter((e) => e.type === 'text')).toHaveLength(2);
  });

  it('pastes external text as a text element instead of the stale internal clipboard', () => {
    const { store } = makeStore([rect('a', 5, 5, 10, 10)]);
    store.getState().actions.copy(['a']);
    const h = createClipboardEventHandlers({ store });
    const { clipboardData } = fakeData({ 'text/plain': 'Hello from another app' });
    const e = ev(clipboardData);
    h.onPaste(e);
    expect(e.preventDefault).toHaveBeenCalled();
    const els = page0(store).elements;
    expect(els.map((x) => x.type)).toEqual(['shape', 'text']);
    expect(els[1]).toMatchObject({ content: 'Hello from another app' });
    expect(store.getState().clipboard).toBeNull();
  });

  it('falls back to the internal clipboard only when the system clipboard is empty', () => {
    const { store } = makeStore([rect('a', 5, 5, 10, 10)]);
    store.getState().actions.copy(['a']);
    const h = createClipboardEventHandlers({ store });
    h.onPaste(ev(fakeData().clipboardData));
    expect(page0(store).elements).toHaveLength(2);
    // Unknown payload (e.g. a newer Plakat): nothing is pasted.
    h.onPaste(ev(fakeData({ [CLIPBOARD_MIME]: '{"format":"plakat.clipboard","version":99}' }).clipboardData));
    expect(page0(store).elements).toHaveLength(2);
  });

  it('handles copy/paste while a slider or switch has focus, but not in text fields', () => {
    const { store } = makeStore([rect('a', 5, 5, 10, 10)]);
    store.getState().actions.select(['a']);
    const range = document.createElement('input');
    range.type = 'range';
    const field = document.createElement('input');
    const h = createClipboardEventHandlers({ store });
    const { data, clipboardData } = fakeData();
    h.onCopy(ev(clipboardData, field));
    expect(data.size).toBe(0);
    h.onCopy(ev(clipboardData, range));
    expect(data.get(CLIPBOARD_MIME)).toContain('plakat.clipboard');
  });
});

describe('shortcuts with a panel control focused', () => {
  it('undo/delete work while a range slider has focus; arrows stay with the slider', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.select(['a']);
    a.updateElement('a', { opacity: 0.5 }, { label: 'Opacity' });
    const range = document.createElement('input');
    range.type = 'range';
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.setAttribute('role', 'switch');
    document.body.append(range, sw);
    const handle = createShortcutHandler({ store, platform: 'other' });
    const fire = (target: HTMLElement, init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
      target.addEventListener('keydown', (ev) => handle(ev), { once: true });
      target.dispatchEvent(e);
      return e;
    };
    fire(range, { key: 'z', ctrlKey: true });
    expect(el(store, 'a').opacity).toBe(1);
    const arrow = fire(range, { key: 'ArrowLeft' });
    expect(arrow.defaultPrevented).toBe(false);
    expect(el(store, 'a').x).toBe(0);
    fire(sw, { key: 'd', ctrlKey: true });
    expect(page0(store).elements).toHaveLength(2);
    fire(sw, { key: 'Backspace' });
    expect(page0(store).elements).toHaveLength(1);
  });
});
