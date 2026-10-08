// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatCombo, getShortcutHelp, isEditableTarget, matchShortcut, SHORTCUTS, type KeyEventLike, type MatchOptions } from './shortcuts.ts';

const mac: MatchOptions = { platform: 'mac', inEditable: false };
const win: MatchOptions = { platform: 'other', inEditable: false };
const m = (e: KeyEventLike, o: MatchOptions = mac) => matchShortcut(e, o)?.id ?? null;

describe('matchShortcut', () => {
  it('maps Mod to Cmd on mac and Ctrl elsewhere', () => {
    expect(m({ key: 'z', metaKey: true })).toBe('undo');
    expect(m({ key: 'z', ctrlKey: true })).toBeNull();
    expect(m({ key: 'z', ctrlKey: true }, win)).toBe('undo');
    expect(m({ key: 'z', metaKey: true }, win)).toBeNull();
  });

  it('redo variants', () => {
    expect(m({ key: 'Z', metaKey: true, shiftKey: true })).toBe('redo');
    expect(m({ key: 'y', ctrlKey: true }, win)).toBe('redo');
    expect(m({ key: 'z', ctrlKey: true, shiftKey: true }, win)).toBe('redo');
  });

  it('edit / selection shortcuts', () => {
    expect(m({ key: 'c', metaKey: true })).toBe('copy');
    expect(m({ key: 'x', metaKey: true })).toBe('cut');
    expect(m({ key: 'v', metaKey: true })).toBe('paste');
    expect(m({ key: 'd', metaKey: true })).toBe('duplicate');
    expect(m({ key: 'a', metaKey: true })).toBe('selectAll');
    expect(m({ key: 'Backspace' })).toBe('delete');
    expect(m({ key: 'Delete' })).toBe('delete');
    expect(m({ key: 'Escape' })).toBe('escape');
    expect(m({ key: 'Backspace', metaKey: true })).toBeNull();
  });

  it('nudges by 1 / 10 px', () => {
    expect(matchShortcut({ key: 'ArrowLeft' }, mac)?.args).toEqual({ dx: -1, dy: 0 });
    expect(matchShortcut({ key: 'ArrowDown', shiftKey: true }, mac)?.args).toEqual({ dx: 0, dy: 10 });
    expect(m({ key: 'ArrowUp', metaKey: true })).toBeNull();
  });

  it('z-order with brackets (by code, Shift for front/back)', () => {
    expect(m({ key: ']', code: 'BracketRight', metaKey: true })).toBe('bringForward');
    expect(m({ key: '[', code: 'BracketLeft', metaKey: true })).toBe('sendBackward');
    expect(m({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })).toBe('bringToFront');
    expect(m({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }, win)).toBe('sendToBack');
  });

  it('group / ungroup / lock', () => {
    expect(m({ key: 'g', metaKey: true })).toBe('group');
    expect(m({ key: 'G', metaKey: true, shiftKey: true })).toBe('ungroup');
    expect(m({ key: 'L', metaKey: true, shiftKey: true })).toBe('toggleLock');
  });

  it('zoom', () => {
    expect(m({ key: '=', code: 'Equal', metaKey: true })).toBe('zoomIn');
    expect(m({ key: '+', code: 'Equal', metaKey: true, shiftKey: true })).toBe('zoomIn');
    expect(m({ key: '-', code: 'Minus', ctrlKey: true }, win)).toBe('zoomOut');
    expect(m({ key: '0', code: 'Digit0', metaKey: true })).toBe('zoomToFit');
    expect(m({ key: '1', code: 'Digit1', metaKey: true })).toBe('zoomTo100');
  });

  it('insert tools need no modifiers', () => {
    expect(m({ key: 't' })).toBe('addText');
    expect(m({ key: 'r' })).toBe('addRect');
    expect(m({ key: 'o' })).toBe('addEllipse');
    expect(m({ key: 'l' })).toBe('addLine');
    expect(m({ key: 't', metaKey: true })).toBeNull();
    expect(m({ key: 'T', shiftKey: true })).toBeNull();
    // non-latin layout: physical key still works
    expect(m({ key: 'е', code: 'KeyT' })).toBe('addText');
  });

  it('file / help', () => {
    expect(m({ key: 's', metaKey: true })).toBe('save');
    expect(m({ key: 'e', metaKey: true })).toBe('export');
    expect(m({ key: '?', shiftKey: true })).toBe('toggleShortcutsHelp');
    expect(m({ key: '/' })).toBeNull();
  });

  it('ignores most shortcuts in editable targets, except Escape and Mod+S', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    div.appendChild(inner);
    document.body.append(input, textarea, div);
    for (const target of [input, textarea, inner]) {
      expect(matchShortcut({ key: 'z', metaKey: true, target }, { platform: 'mac' })).toBeNull();
      expect(matchShortcut({ key: 'Backspace', target }, { platform: 'mac' })).toBeNull();
      expect(matchShortcut({ key: 'Escape', target }, { platform: 'mac' })?.id).toBe('escape');
      expect(matchShortcut({ key: 's', metaKey: true, target }, { platform: 'mac' })?.id).toBe('save');
    }
    expect(isEditableTarget(document.body)).toBe(false);
    expect(matchShortcut({ key: 'Backspace', target: document.body }, { platform: 'mac' })?.id).toBe('delete');
  });

  it('treats sliders, switches and buttons as non-editable (Mod+Z, Delete keep working)', () => {
    const make = (type: string) => {
      const i = document.createElement('input');
      i.type = type;
      return i;
    };
    for (const type of ['range', 'checkbox', 'radio', 'color', 'button']) {
      const t = make(type);
      expect(isEditableTarget(t)).toBe(false);
      expect(matchShortcut({ key: 'z', metaKey: true, target: t }, { platform: 'mac' })?.id).toBe('undo');
      expect(matchShortcut({ key: 'Backspace', target: t }, { platform: 'mac' })?.id).toBe('delete');
    }
    for (const type of ['text', 'number', 'search', 'email', 'url', 'password', 'tel', 'date']) expect(isEditableTarget(make(type))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
    // Arrow keys on a focused slider keep their native behavior (no nudge).
    expect(matchShortcut({ key: 'ArrowLeft', target: make('range') }, { platform: 'mac' })).toBeNull();
    expect(matchShortcut({ key: 'ArrowLeft', target: make('checkbox') }, { platform: 'mac' })?.id).toBe('nudge');
  });

  it('ignores IME composition and auto-repeat for toggles', () => {
    expect(m({ key: 'z', metaKey: true, isComposing: true })).toBeNull();
    expect(m({ key: 'g', metaKey: true, repeat: true })).toBeNull();
    expect(m({ key: 'ArrowLeft', repeat: true })).toBe('nudge');
  });
});

describe('help', () => {
  it('formats combos per platform', () => {
    const redo = SHORTCUTS.find((s) => s.id === 'redo')!;
    expect(formatCombo(redo.combos[0]!, 'mac')).toBe('⌘⇧Z');
    expect(formatCombo(redo.combos[0]!, 'other')).toBe('Ctrl+Shift+Z');
    const groups = getShortcutHelp('other');
    expect(groups.map((g) => g.group)).toEqual(['Edit', 'Selection', 'Arrange', 'View', 'Insert', 'File', 'Help']);
    expect(groups.find((g) => g.group === 'View')!.items.find((i) => i.id === 'zoomIn')!.keys).toEqual(['Ctrl+=']);
  });
});
