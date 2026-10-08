// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';

afterEach(cleanup);

describe('Dialog focus', () => {
  it('takes focus as soon as it opens, so an immediate Escape closes it', () => {
    vi.useFakeTimers();
    try {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      outside.focus();
      const onClose = vi.fn();
      const { rerender } = render(
        <Dialog open={false} onClose={onClose} title="Help">
          <p>body</p>
        </Dialog>,
      );
      rerender(
        <Dialog open onClose={onClose} title="Help">
          <p>body</p>
        </Dialog>,
      );
      // Before the deferred autofocus timer has run, focus is already inside the dialog.
      const dialog = screen.getByRole('dialog', { name: 'Help' });
      expect(dialog.contains(document.activeElement)).toBe(true);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);

      // The deferred autofocus still moves focus from the panel to its first control.
      act(() => vi.runAllTimers());
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
      outside.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
