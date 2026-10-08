/**
 * Keyboard-operable dropdown menu (WAI-ARIA menu button pattern): Enter/Space/ArrowDown
 * on the trigger opens it, ArrowUp/Down/Home/End move, Enter/Space activates, Escape
 * closes and returns focus to the trigger, Tab closes.
 */
import { useId, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { Popover, type Placement } from './Popover.tsx';
import { cx } from './ui.tsx';

export type MenuEntry =
  | {
      id: string;
      label: string;
      icon?: IconName;
      /** Right-aligned hint, e.g. a shortcut. */
      hint?: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      /** Renders as menuitemcheckbox / menuitemradio with this checked state. */
      checked?: boolean;
    }
  | { separator: true; id: string }
  | { heading: string; id: string };

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  items: ReadonlyArray<MenuEntry>;
  trigger: (props: MenuTriggerProps, open: boolean) => ReactNode;
  placement?: Placement;
  width?: number;
  className?: string;
}

type ActionEntry = Extract<MenuEntry, { onSelect: () => void }>;
const isAction = (e: MenuEntry): e is ActionEntry => 'onSelect' in e;

export function Menu({ label, items, trigger, placement = 'bottom-start', width, className }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const focusItem = (index: number | 'first' | 'last') => {
    requestAnimationFrame(() => {
      const nodes = [...(listRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
      if (!nodes.length) return;
      const i = index === 'first' ? 0 : index === 'last' ? nodes.length - 1 : Math.max(0, Math.min(nodes.length - 1, index));
      nodes[i]!.focus();
    });
  };

  const openMenu = (focus: 'first' | 'last' = 'first') => {
    setOpen(true);
    focusItem(focus);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => (open ? close(false) : openMenu()),
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu('first');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu('last');
      }
    },
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const nodes = [...(listRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        nodes[(current + 1) % nodes.length]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        nodes[(current - 1 + nodes.length) % nodes.length]?.focus();
        break;
      case 'Home':
        e.preventDefault();
        nodes[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        nodes[nodes.length - 1]?.focus();
        break;
      case 'Tab':
        close(false);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const ch = e.key.toLowerCase();
          const start = current + 1;
          for (let k = 0; k < nodes.length; k++) {
            const n = nodes[(start + k) % nodes.length]!;
            if ((n.textContent ?? '').trim().toLowerCase().startsWith(ch)) {
              n.focus();
              break;
            }
          }
        }
    }
  };

  const activate = (entry: ActionEntry) => {
    if (entry.disabled) return;
    close(true);
    entry.onSelect();
  };

  return (
    <>
      {trigger(triggerProps, open)}
      <Popover open={open} onClose={() => close(false)} anchor={triggerRef} placement={placement} role="presentation" autoFocus={false} width={width}>
        <div ref={listRef} id={menuId} role="menu" aria-label={label} className={cx('menu', className)} onKeyDown={onMenuKeyDown}>
          {items.map((entry) => {
            if ('separator' in entry) return <div key={entry.id} role="separator" className="menu__sep" />;
            if ('heading' in entry)
              return (
                <div key={entry.id} className="menu__heading" role="presentation">
                  {entry.heading}
                </div>
              );
            const role = entry.checked === undefined ? 'menuitem' : 'menuitemradio';
            return (
              <div
                key={entry.id}
                role={role}
                tabIndex={-1}
                aria-disabled={entry.disabled || undefined}
                aria-checked={entry.checked === undefined ? undefined : entry.checked}
                className={cx('menu__item', entry.danger && 'menu__item--danger', entry.disabled && 'is-disabled')}
                onClick={() => activate(entry)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activate(entry);
                  }
                }}
              >
                <span className="menu__icon">{entry.checked ? <Icon name="check" size={16} /> : entry.icon ? <Icon name={entry.icon} size={16} /> : null}</span>
                <span className="menu__label">{entry.label}</span>
                {entry.hint && <span className="menu__hint">{entry.hint}</span>}
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
