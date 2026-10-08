/**
 * Color picker: swatch trigger + popover with palettes (brand, document, defaults),
 * the native color input, a hex field and an opacity slider (#rrggbbaa).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { COLOR_PATTERN, type Color } from '@plakat/schema';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { cx } from './ui.tsx';

export interface ColorPalette {
  id: string;
  title: string;
  colors: readonly Color[];
}

export const DEFAULT_PALETTE: readonly Color[] = [
  '#000000', '#545454', '#a6a6a6', '#ffffff',
  '#ff3131', '#ff914d', '#ffde59', '#7ed957',
  '#00bf63', '#0cc0df', '#5271ff', '#004aad',
  '#8c52ff', '#cb6ce6', '#ff66c4', '#7b3f00',
];

/** Normalizes "#abc", "abc", "#aabbcc", "#aabbccdd" to lowercase #rrggbb[aa]; null if invalid. */
export function normalizeHex(input: string): Color | null {
  let s = input.trim().toLowerCase();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (/^#[0-9a-f]{4}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}${s[4]}${s[4]}`;
  return COLOR_PATTERN.test(s) ? s : null;
}

export const rgbPart = (c: Color): string => c.slice(0, 7).toLowerCase();
export function alphaOf(c: Color): number {
  return c.length === 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1;
}
export function withAlpha(c: Color, alpha: number): Color {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return a >= 255 ? rgbPart(c) : `${rgbPart(c)}${a.toString(16).padStart(2, '0')}`;
}

export interface ColorPickerProps {
  label: string;
  value: Color | null;
  /** `live` = continuous change (slider/native picker drag); callers coalesce. */
  onChange: (value: Color | null, live: boolean) => void;
  /** Offer "No color" (null). */
  allowNone?: boolean;
  noneLabel?: string;
  palettes?: readonly ColorPalette[];
  /** Show the hex value next to the swatch. */
  showValue?: boolean;
  /** Mixed selection: show an indeterminate swatch. */
  mixed?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ColorSwatch({ color, size = 22, className }: { color: Color | null; size?: number; className?: string }): JSX.Element {
  return (
    <span className={cx('swatch', color === null && 'swatch--none', className)} style={{ width: size, height: size }} aria-hidden="true">
      {color !== null && <span className="swatch__fill" style={{ background: color }} />}
    </span>
  );
}

export function ColorPicker({
  label,
  value,
  onChange,
  allowNone,
  noneLabel = 'No color',
  palettes = [],
  showValue,
  mixed,
  disabled,
  className,
}: ColorPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [hex, setHex] = useState(value ?? '');
  useEffect(() => setHex(value ?? ''), [value]);

  const all: ColorPalette[] = [...palettes.filter((p) => p.colors.length > 0), { id: 'default', title: 'Default colors', colors: DEFAULT_PALETTE }];
  const current = value ? rgbPart(value) : null;
  const alpha = value ? alphaOf(value) : 1;
  const pick = (c: Color) => onChange(value && alpha < 1 ? withAlpha(c, alpha) : rgbPart(c), false);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx('color-trigger', showValue && 'color-trigger--value', className)}
        aria-label={`${label}: ${mixed ? 'mixed' : (value ?? noneLabel)}`}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <ColorSwatch color={mixed ? null : value} className={mixed ? 'swatch--mixed' : undefined} />
        {showValue && <span className="color-trigger__value">{mixed ? 'Mixed' : (value ?? noneLabel)}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={label} className="color-pop" width={256} placement="bottom-start">
        <div className="color-pop__inner">
          {allowNone && (
            <button type="button" className={cx('color-none', value === null && 'is-selected')} onClick={() => onChange(null, false)} aria-pressed={value === null}>
              <ColorSwatch color={null} size={20} />
              <span>{noneLabel}</span>
            </button>
          )}
          {all.map((p) => (
            <div key={p.id} className="color-pop__group">
              <div className="color-pop__title">{p.title}</div>
              <div className="color-grid" role="group" aria-label={p.title}>
                {p.colors.map((c, i) => (
                  <button
                    key={`${c}-${i}`}
                    type="button"
                    className={cx('color-cell', current === rgbPart(c) && 'is-selected')}
                    aria-label={c}
                    title={c}
                    aria-pressed={current === rgbPart(c)}
                    onClick={() => pick(c)}
                  >
                    <span style={{ background: c }} />
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="color-pop__custom">
            <label className="color-native" title="Custom color">
              <input
                type="color"
                aria-label={`${label} custom color`}
                value={current ?? '#000000'}
                onChange={(e) => onChange(alpha < 1 ? withAlpha(e.target.value, alpha) : e.target.value.toLowerCase(), true)}
              />
              <Icon name="palette" size={16} />
            </label>
            <input
              className="input input--mono color-hex"
              aria-label={`${label} hex value`}
              value={hex}
              placeholder="#000000"
              spellCheck={false}
              onChange={(e) => setHex(e.target.value)}
              onBlur={() => {
                const n = normalizeHex(hex);
                if (n && n !== value) onChange(n, false);
                else setHex(value ?? '');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const n = normalizeHex(hex);
                  if (n) onChange(n, false);
                  else setHex(value ?? '');
                }
              }}
            />
          </div>
          {value !== null && (
            <label className="color-alpha">
              <span>Opacity</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(alpha * 100)}
                aria-label={`${label} opacity`}
                onChange={(e) => onChange(withAlpha(value, Number(e.target.value) / 100), true)}
              />
              <span className="color-alpha__val">{Math.round(alpha * 100)}%</span>
            </label>
          )}
        </div>
      </Popover>
    </>
  );
}
