/**
 * Toast notifications: a tiny vanilla zustand store (callable from anywhere) plus the
 * <Toaster/> renderer (aria-live region).
 */
import { useEffect, type JSX } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { Icon } from '../components/Icon.tsx';
import { IconButton, cx } from '../components/ui.tsx';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional secondary line. */
  detail?: string;
  actions?: ToastAction[];
  /** ms; 0 = sticky. Default 5000 (errors 8000). */
  duration?: number;
  /** Toasts with the same key replace each other. */
  key?: string;
}

interface ToastState {
  toasts: Toast[];
}

let seq = 0;
export const toastStore = createStore<ToastState>()(() => ({ toasts: [] }));

/** Shows a toast; returns its id. */
export function showToast(t: Omit<Toast, 'id'>): number {
  const id = ++seq;
  toastStore.setState((s) => ({
    toasts: [...s.toasts.filter((x) => !(t.key && x.key === t.key)), { ...t, id }].slice(-5),
  }));
  return id;
}

export function dismissToast(idOrKey: number | string): void {
  toastStore.setState((s) => ({ toasts: s.toasts.filter((x) => (typeof idOrKey === 'number' ? x.id !== idOrKey : x.key !== idOrKey)) }));
}

export const toast = {
  info: (message: string, extra: Partial<Omit<Toast, 'id' | 'kind' | 'message'>> = {}) => showToast({ kind: 'info', message, ...extra }),
  success: (message: string, extra: Partial<Omit<Toast, 'id' | 'kind' | 'message'>> = {}) => showToast({ kind: 'success', message, ...extra }),
  warning: (message: string, extra: Partial<Omit<Toast, 'id' | 'kind' | 'message'>> = {}) => showToast({ kind: 'warning', message, ...extra }),
  error: (message: string, extra: Partial<Omit<Toast, 'id' | 'kind' | 'message'>> = {}) => showToast({ kind: 'error', message, ...extra }),
};

/** A readable message from any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return typeof e === 'string' ? e : 'Something went wrong';
}

function ToastItem({ t }: { t: Toast }): JSX.Element {
  useEffect(() => {
    const ms = t.duration ?? (t.kind === 'error' ? 8000 : 5000);
    if (ms <= 0) return;
    const timer = setTimeout(() => dismissToast(t.id), ms);
    return () => clearTimeout(timer);
  }, [t.id, t.duration, t.kind]);
  const icon = t.kind === 'success' ? 'check' : t.kind === 'info' ? 'info' : 'warning';
  return (
    <div className={cx('toast', `toast--${t.kind}`)} role={t.kind === 'error' ? 'alert' : 'status'}>
      <span className="toast__icon">
        <Icon name={icon} size={18} />
      </span>
      <div className="toast__body">
        <div className="toast__msg">{t.message}</div>
        {t.detail && <div className="toast__detail">{t.detail}</div>}
        {t.actions && t.actions.length > 0 && (
          <div className="toast__actions">
            {t.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="toast__action"
                onClick={() => {
                  dismissToast(t.id);
                  a.onClick();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <IconButton label="Dismiss notification" icon="close" size="sm" onClick={() => dismissToast(t.id)} />
    </div>
  );
}

export function Toaster(): JSX.Element {
  const toasts = useStore(toastStore, (s) => s.toasts);
  return (
    <div className="toaster" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
