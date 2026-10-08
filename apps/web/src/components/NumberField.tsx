/**
 * Numeric input that keeps a local draft while typing and commits on Enter / blur.
 * ArrowUp/Down step by `step` (Shift: ×10) and commit immediately. `null` value =
 * mixed selection (shows "Mixed" placeholder). `displayScale` converts stored values
 * to shown values (e.g. opacity 0..1 shown as 0..100 %).
 */
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { cx } from './ui.tsx';

export interface NumberFieldProps {
  /** Accessible name (always announced). */
  label: string;
  /** Short visible adornment before the input (e.g. "X", "W"); defaults to none. */
  prefix?: string;
  suffix?: string;
  value: number | null;
  onChange: (value: number, source: 'type' | 'step') => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimals shown (default 0). */
  precision?: number;
  displayScale?: number;
  disabled?: boolean;
  className?: string;
  /** Show the label above the input (default false: label is visually hidden). */
  showLabel?: boolean;
  id?: string;
}

const round = (v: number, precision: number) => {
  const f = 10 ** precision;
  return Math.round(v * f) / f;
};

export function formatNumber(value: number | null, precision: number, scale = 1): string {
  if (value === null || !Number.isFinite(value)) return '';
  const v = round(value * scale, precision);
  return String(Object.is(v, -0) ? 0 : v);
}

/** Parses user input ("12", "12.5", "1,5", "12px", "50%") to a number, or null. */
export function parseNumberInput(text: string): number | null {
  const cleaned = text.trim().replace(',', '.').replace(/[^\d.eE+\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function NumberField({
  label,
  prefix,
  suffix,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 0,
  displayScale = 1,
  disabled,
  className,
  showLabel,
  id,
}: NumberFieldProps): JSX.Element {
  const auto = useId();
  const inputId = id ?? auto;
  const [draft, setDraft] = useState(() => formatNumber(value, precision, displayScale));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(formatNumber(value, precision, displayScale));
  }, [value, precision, displayScale]);

  const clampShown = (shown: number) => {
    const lo = min * displayScale;
    const hi = max * displayScale;
    return Math.min(hi, Math.max(lo, shown));
  };

  const commit = (text: string) => {
    const parsed = parseNumberInput(text);
    if (parsed === null) {
      setDraft(formatNumber(value, precision, displayScale));
      return;
    }
    const shown = clampShown(parsed);
    const next = shown / displayScale;
    setDraft(formatNumber(next, precision, displayScale));
    if (value === null || Math.abs(next - value) > 1e-9) onChange(next, 'type');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(e.currentTarget.value);
      e.currentTarget.select();
    } else if (e.key === 'Escape') {
      setDraft(formatNumber(value, precision, displayScale));
      editing.current = false;
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parseNumberInput(e.currentTarget.value) ?? (value ?? 0) * displayScale;
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      const shown = clampShown(round(base + delta, Math.max(precision, 4)));
      const next = shown / displayScale;
      setDraft(formatNumber(next, precision, displayScale));
      onChange(next, 'step');
    }
  };

  return (
    <div className={cx('num', disabled && 'is-disabled', showLabel && 'num--labelled', className)}>
      {showLabel && (
        <label className="num__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className="num__box">
        {prefix && (
          <span className="num__prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          className="num__input"
          type="text"
          inputMode="decimal"
          aria-label={showLabel ? undefined : label}
          value={draft}
          placeholder={value === null ? 'Mixed' : undefined}
          disabled={disabled}
          onFocus={(e) => {
            editing.current = true;
            e.currentTarget.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            editing.current = false;
            commit(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
        />
        {suffix && (
          <span className="num__suffix" aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
