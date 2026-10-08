/** Labelled range slider with a numeric readout/input. */
import { useId, type JSX } from 'react';
import { NumberField } from './NumberField.tsx';
import { cx } from './ui.tsx';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Shown value = value × displayScale (e.g. 100 for percentages). */
  displayScale?: number;
  precision?: number;
  suffix?: string;
  /** Live changes while dragging (callers coalesce them into one undo step). */
  onChange: (value: number) => void;
  /** Called when a drag ends (pointer up / key up). */
  onCommit?: () => void;
  disabled?: boolean;
  className?: string;
  /** Neutral point drawn as a tick (e.g. 0 for brightness). */
  center?: number;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  displayScale = 1,
  precision = 0,
  suffix,
  onChange,
  onCommit,
  disabled,
  className,
  center,
}: SliderProps): JSX.Element {
  const id = useId();
  const pct = ((value - min) / (max - min || 1)) * 100;
  const centerPct = center === undefined ? null : ((center - min) / (max - min || 1)) * 100;
  const fillFrom = centerPct ?? 0;
  const lo = Math.min(fillFrom, pct);
  const hi = Math.max(fillFrom, pct);
  return (
    <div className={cx('slider', disabled && 'is-disabled', className)}>
      <div className="slider__head">
        <label htmlFor={id} className="slider__label">
          {label}
        </label>
        <NumberField
          label={`${label} value`}
          value={value}
          min={min}
          max={max}
          step={step}
          precision={precision}
          displayScale={displayScale}
          suffix={suffix}
          disabled={disabled}
          className="slider__num"
          onChange={(v) => {
            onChange(v);
            onCommit?.();
          }}
        />
      </div>
      <input
        id={id}
        type="range"
        className="slider__range"
        min={min}
        max={max}
        step={step / displayScale}
        value={value}
        disabled={disabled}
        style={{ ['--lo' as string]: `${lo}%`, ['--hi' as string]: `${hi}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={() => onCommit?.()}
        onKeyUp={() => onCommit?.()}
      />
    </div>
  );
}
