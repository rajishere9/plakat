// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatCombo, getGestureHelp, matchShortcut, SHORTCUTS } from '../lib/shortcuts.ts';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';

afterEach(cleanup);

/** Rows of the dialog as [label, keys[]]. */
function rows(): [string, string[]][] {
  const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
  return Array.from(dialog.querySelectorAll('.shortcuts__row')).map((row) => [
    row.querySelector('dt')!.textContent!,
    Array.from(row.querySelectorAll('kbd')).map((k) => k.textContent!),
  ]);
}

describe('ShortcutsDialog', () => {
  it('lists every keyboard binding with the keys matchShortcut really accepts (mac and other)', () => {
    for (const platform of ['mac', 'other'] as const) {
      render(<ShortcutsDialog open onClose={() => {}} platform={platform} />);
      const shown = new Map(rows());
      for (const def of SHORTCUTS) {
        const keys = shown.get(def.label);
        expect(keys, `${def.id} missing on ${platform}`).toBeDefined();
        // Every displayed combo maps back to this shortcut when pressed.
        for (const combo of def.combos.filter((c) => !(c.code ?? '').startsWith('Numpad'))) {
          expect(keys).toContain(formatCombo(combo, platform));
          const mod = combo.mod ? (platform === 'mac' ? { metaKey: true } : { ctrlKey: true }) : {};
          const ev = { key: combo.key, code: combo.code, shiftKey: combo.shift === true, altKey: !!combo.alt, ...mod };
          expect(matchShortcut(ev, { platform, inEditable: false })?.id).toBe(def.id);
        }
      }
      cleanup();
    }
  });

  it('also documents the canvas gestures that are not keyboard bindings', () => {
    render(<ShortcutsDialog open onClose={() => {}} platform="other" />);
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const section = within(dialog).getByRole('heading', { name: 'Mouse and canvas' }).closest('section')!;
    const shown = Array.from(section.querySelectorAll('dt')).map((d) => d.textContent);
    expect(shown).toEqual(getGestureHelp('other').map((g) => g.label));
    expect(within(section).getByText('Alt+Drag')).toBeTruthy();
    expect(within(section).getByText('Space+Drag')).toBeTruthy();
    expect(within(section).getByText('Ctrl+Scroll')).toBeTruthy();
  });
});
