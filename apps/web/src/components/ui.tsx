/** Small presentational primitives: buttons, fields, segmented controls, switches, spinners. */
import { forwardRef, useId, type ButtonHTMLAttributes, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.tsx';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  busy?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, busy, block, className, children, type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('btn', `btn--${variant}`, `btn--${size}`, block && 'btn--block', className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children !== undefined && children !== null && <span className="btn__label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={16} />}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name (also the tooltip). Required: icon buttons have no visible text. */
  label: string;
  icon: IconName;
  size?: 'sm' | 'md' | 'lg';
  /** Toggle buttons: rendered with aria-pressed. */
  pressed?: boolean;
  variant?: 'ghost' | 'secondary' | 'primary';
  iconSize?: number;
  /** Tooltip text (defaults to label); pass shortcut hints here. */
  tooltip?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', pressed, variant = 'ghost', className, type = 'button', iconSize, tooltip, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={tooltip ?? label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={cx('icon-btn', `icon-btn--${size}`, `icon-btn--${variant}`, pressed && 'is-pressed', className)}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? (size === 'sm' ? 16 : size === 'lg' ? 22 : 18)} />
    </button>
  );
});

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface FieldProps {
  label: ReactNode;
  /** id of the control; generated when omitted (passed to children as render prop). */
  id?: string;
  hint?: ReactNode;
  inline?: boolean;
  className?: string;
  children: ReactNode | ((id: string) => ReactNode);
}

export function Field({ label, id, hint, inline, className, children }: FieldProps): JSX.Element {
  const auto = useId();
  const controlId = id ?? auto;
  return (
    <div className={cx('field', inline && 'field--inline', className)}>
      <label className="field__label" htmlFor={controlId}>
        {label}
      </label>
      <div className="field__control">{typeof children === 'function' ? children(controlId) : children}</div>
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ options, className, ...rest }, ref) {
  return (
    <div className={cx('select', className)}>
      <select ref={ref} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={14} className="select__chevron" />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Segmented control (radio group) and toggle group
// ---------------------------------------------------------------------------

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  label: string;
  value: T | null;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  /** Show icons only (labels become aria-labels / tooltips). */
  iconsOnly?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}

/** A radiogroup of buttons; arrow keys move the selection (roving tabindex). */
export function Segmented<T extends string>({ label, value, options, onChange, iconsOnly, className, size = 'md' }: SegmentedProps<T>): JSX.Element {
  const enabled = options.filter((o) => !o.disabled);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key) || enabled.length === 0) return;
    e.preventDefault();
    const idx = Math.max(0, enabled.findIndex((o) => o.value === value));
    let next = idx;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else next = (idx + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
    const opt = enabled[next]!;
    onChange(opt.value);
    const group = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => [...group.querySelectorAll<HTMLElement>('[data-value]')].find((n) => n.dataset['value'] === opt.value)?.focus());
  };
  const focusValue = value !== null && enabled.some((o) => o.value === value) ? value : enabled[0]?.value;
  return (
    <div role="radiogroup" aria-label={label} className={cx('seg', `seg--${size}`, iconsOnly && 'seg--icons', className)} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconsOnly ? o.label : undefined}
            title={iconsOnly ? o.label : undefined}
            data-value={o.value}
            tabIndex={o.value === focusValue ? 0 : -1}
            disabled={o.disabled}
            className={cx('seg__item', checked && 'is-checked')}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <Icon name={o.icon} size={16} />}
            {!iconsOnly && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Visually hide the text label (still announced). */
  hideLabel?: boolean;
}

export function Switch({ label, checked, onChange, disabled, hideLabel }: SwitchProps): JSX.Element {
  return (
    <label className={cx('switch', disabled && 'is-disabled')}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className={hideLabel ? 'sr-only' : 'switch__label'}>{label}</span>
    </label>
  );
}

export interface CheckboxProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function Checkbox({ label, checked, onChange, disabled, className, ...rest }: CheckboxProps): JSX.Element {
  return (
    <label className={cx('checkbox', disabled && 'is-disabled', className)}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={rest['aria-label']} />
      <span className="checkbox__box" aria-hidden="true">
        <Icon name="check" size={12} strokeWidth={3} />
      </span>
      <span className="checkbox__label">{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Spinner({ size = 18, label }: { size?: number; label?: string }): JSX.Element {
  return (
    <span className="spinner" role={label ? 'status' : undefined} aria-label={label} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.2" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number | null; label: string }): JSX.Element {
  const pct = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={cx('progress', pct === null && 'progress--indeterminate')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
    >
      <div className="progress__bar" style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

export interface EmptyStateProps {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'error';
  compact?: boolean;
}

export function EmptyState({ icon = 'info', title, children, action, tone = 'neutral', compact }: EmptyStateProps): JSX.Element {
  return (
    <div className={cx('empty', `empty--${tone}`, compact && 'empty--compact')} role={tone === 'error' ? 'alert' : undefined}>
      <div className="empty__icon">
        <Icon name={tone === 'error' ? 'warning' : icon} size={compact ? 20 : 28} />
      </div>
      <div className="empty__title">{title}</div>
      {children && <div className="empty__body">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', children, icon }: { tone?: 'info' | 'warning' | 'error' | 'success'; children: ReactNode; icon?: IconName }): JSX.Element {
  return (
    <div className={cx('notice', `notice--${tone}`)} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={icon ?? (tone === 'info' ? 'info' : tone === 'success' ? 'check' : 'warning')} size={16} />
      <div className="notice__body">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="kbd">{children}</kbd>;
}

export function SectionHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }): JSX.Element {
  return (
    <div className="section__header">
      <h3 className="section__title">{title}</h3>
      {actions && <div className="section__actions">{actions}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return (
    <section className={cx('section', className)}>
      {title !== undefined && <SectionHeader title={title} actions={actions} />}
      {children}
    </section>
  );
}
