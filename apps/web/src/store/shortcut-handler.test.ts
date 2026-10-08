// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_MIME } from '../lib/clipboard.ts';
import { createClipboardEventHandlers, createShortcutHandler } from './shortcut-handler.ts';
import { el, makeStore, page0, rect } from './test-helpers.ts';

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
});
