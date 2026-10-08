/**
 * Modal dialog: portal + overlay, role="dialog" aria-modal, focus trap, Escape and
 * overlay click close, focus restored to the previously focused element.
 */
import { useEffect, useId, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, cx } from './ui.tsx';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** Prevent closing (e.g. while an export runs). */
  dismissible?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Number of open dialogs (shortcut handlers ignore keys while > 0). */
let openDialogs = 0;
export const isDialogOpen = (): boolean => openDialogs > 0;

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', className, dismissible = true }: DialogProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  useEffect(() => {
    if (!open) return;
    openDialogs++;
    const previous = document.activeElement as HTMLElement | null;
    // Take focus right away so Escape and Tab reach the dialog even when pressed before the
    // deferred autofocus below runs (e.g. `?` then Escape in quick succession on the canvas,
    // whose window-level shortcuts are muted while a dialog is open).
    const initial = panelRef.current;
    if (initial && !initial.contains(document.activeElement)) initial.focus({ preventScroll: true });
    const t = setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || (panel.contains(document.activeElement) && document.activeElement !== panel)) return;
      (panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();
    });
    return () => {
      clearTimeout(t);
      openDialogs = Math.max(0, openDialogs - 1);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (dismissRef.current) onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => !n.closest('[aria-hidden="true"]'));
    if (!nodes.length) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cx('dialog', `dialog--${size}`, className)}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dialog__header">
          <div>
            <h2 id={titleId} className="dialog__title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="dialog__desc">
                {description}
              </p>
            )}
          </div>
          {dismissible && <IconButton label="Close" icon="close" onClick={() => onCloseRef.current()} />}
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
