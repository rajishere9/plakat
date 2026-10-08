/** Keyboard shortcuts help (from lib/shortcuts SHORTCUTS via getShortcutHelp). */
import type { JSX } from 'react';
import { Dialog } from '../components/Dialog.tsx';
import { Kbd } from '../components/ui.tsx';
import { detectPlatform, getShortcutHelp, type Platform } from '../lib/shortcuts.ts';

export function ShortcutsDialog({ open, onClose, platform }: { open: boolean; onClose: () => void; platform?: Platform }): JSX.Element | null {
  const groups = getShortcutHelp(platform ?? detectPlatform());
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="lg">
      <div className="shortcuts">
        {groups.map((g) => (
          <section key={g.group} className="shortcuts__group">
            <h3 className="shortcuts__title">{g.group}</h3>
            <dl className="shortcuts__list">
              {g.items.map((it) => (
                <div key={it.id} className="shortcuts__row">
                  <dt>{it.label}</dt>
                  <dd>
                    {it.keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="shortcuts__or">or</span>}
                        <Kbd>{k}</Kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
