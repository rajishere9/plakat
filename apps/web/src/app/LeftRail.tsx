/** Left icon rail; each button toggles its flyout panel (store.activePanel). */
import type { JSX } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { cx } from '../components/ui.tsx';
import { useEd, useStoreApi } from './services.tsx';

export interface RailItem {
  id: string;
  label: string;
  icon: IconName;
}

export const RAIL_ITEMS: readonly RailItem[] = [
  { id: 'templates', label: 'Templates', icon: 'templates' },
  { id: 'shapes', label: 'Elements', icon: 'shapes' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'uploads', label: 'Uploads', icon: 'uploads' },
  { id: 'photos', label: 'Photos', icon: 'photos' },
  { id: 'brand', label: 'Brand', icon: 'brand' },
  { id: 'layers', label: 'Layers', icon: 'layers' },
  { id: 'pages', label: 'Pages', icon: 'pages' },
];

export const FLYOUT_ID = 'plakat-flyout';

export function LeftRail(): JSX.Element {
  const store = useStoreApi();
  const active = useEd((s) => s.activePanel);
  return (
    <nav className="rail" aria-label="Tools">
      {RAIL_ITEMS.map((it) => {
        const on = active === it.id;
        return (
          <button
            key={it.id}
            type="button"
            className={cx('rail__btn', on && 'is-active')}
            aria-pressed={on}
            aria-controls={on ? FLYOUT_ID : undefined}
            onClick={() => store.getState().actions.togglePanel(it.id)}
          >
            <span className="rail__icon">
              <Icon name={it.icon} size={22} />
            </span>
            <span className="rail__label">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
