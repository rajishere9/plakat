/**
 * Anchored floating surface (portal, position: fixed). Closes on outside pointer
 * down and Escape (focus returns to the anchor). Used by menus, the color picker and
 * the font picker.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './ui.tsx';

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'right-start' | 'left-start';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
  placement?: Placement;
  /** Accessible label of the surface (role=dialog unless `role` is given). */
  label?: string;
  role?: string;
  className?: string;
  width?: number;
  /** Gap between anchor and surface. */
  offset?: number;
  /** Focus the first focusable descendant on open (default true). */
  autoFocus?: boolean;
  /** Return focus to the anchor on close (default true). */
  restoreFocus?: boolean;
  id?: string;
}

const MARGIN = 8;

export function computePosition(anchor: DOMRect, size: { width: number; height: number }, placement: Placement, offset: number, viewport: { width: number; height: number }) {
  let top: number;
  let left: number;
  switch (placement) {
    case 'bottom-end':
      top = anchor.bottom + offset;
      left = anchor.right - size.width;
      break;
    case 'top-start':
      top = anchor.top - offset - size.height;
      left = anchor.left;
      break;
    case 'right-start':
      top = anchor.top;
      left = anchor.right + offset;
      break;
    case 'left-start':
      top = anchor.top;
      left = anchor.left - offset - size.width;
      break;
    default:
      top = anchor.bottom + offset;
      left = anchor.left;
  }
  // Flip vertically when overflowing.
  if (placement.startsWith('bottom') && top + size.height > viewport.height - MARGIN && anchor.top - offset - size.height > MARGIN) {
    top = anchor.top - offset - size.height;
  }
  if (placement === 'right-start' && left + size.width > viewport.width - MARGIN) left = anchor.left - offset - size.width;
  left = Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, viewport.height - size.height - MARGIN));
  return { top, left };
}

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), select, textarea, a[href]';

export function Popover({
  open,
  onClose,
  anchor,
  children,
  placement = 'bottom-start',
  label,
  role = 'dialog',
  className,
  width,
  offset = 6,
  autoFocus = true,
  restoreFocus = true,
  id,
}: PopoverProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const a = anchor.current;
    const el = ref.current;
    if (!a || !el) return;
    const rect = a.getBoundingClientRect();
    const size = { width: el.offsetWidth || width || 240, height: el.offsetHeight || 200 };
    setPos(computePosition(rect, size, placement, offset, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor, placement, offset, width]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const onWin = () => place();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && ref.current) {
      ro = new ResizeObserver(onWin);
      ro.observe(ref.current);
    }
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
      ro?.disconnect();
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const anchorEl = anchor.current;
    if (autoFocus) {
      const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus() ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
      void t;
    }
    const onPointer = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        if (restoreFocus) anchorEl?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, autoFocus, restoreFocus]);

  if (!open || typeof document === 'undefined') return null;
  const style: CSSProperties = {
    position: 'fixed',
    top: pos?.top ?? -9999,
    left: pos?.left ?? -9999,
    width,
    visibility: pos ? 'visible' : 'hidden',
  };
  return createPortal(
    <div ref={ref} id={id} role={role} aria-label={label} className={cx('popover', className)} style={style} data-plakat-popover="">
      {children}
    </div>,
    document.body,
  );
}
