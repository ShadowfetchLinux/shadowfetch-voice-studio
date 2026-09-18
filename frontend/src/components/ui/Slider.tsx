import { useId, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { ControlSpec } from "@/lib/protocol";
import { clamp, cx } from "@/lib/format";
import { IconButton } from "./Button";

export interface SliderProps {
  label: ReactNode;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Default value; shows a reset button when the current value differs. */
  defaultValue?: number;
  description?: ReactNode;
  /** Unit or formatter for the numeric readout. */
  format?: (v: number) => string;
  disabled?: boolean;
  className?: string;
}

/**
 * Range slider with a numeric readout/input. Render it only for controls an engine declared
 * (see `ControlSlider`), never for invented parameters.
 */
export function Slider({ label, value, onChange, min, max, step = 0.01, defaultValue, description, format, disabled, className }: SliderProps) {
  const id = useId();
  const decimals = Math.max(0, Math.min(4, -Math.floor(Math.log10(step))));
  const text = format ? format(value) : value.toFixed(decimals);
  const dirty = defaultValue !== undefined && Math.abs(value - defaultValue) > 1e-9;
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium">
          {label}
        </label>
        <div className="flex items-center gap-1">
          <input
            type="number"
            aria-label={`${typeof label === "string" ? label : "value"} (number)`}
            value={Number.isFinite(value) ? value : ""}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) onChange(clamp(v, min, max));
            }}
            className="field-input h-8 w-[84px] px-2 text-right text-[13px] tabular-nums"
          />
          {dirty && (
            <IconButton size="sm" label="Reset to default" onClick={() => onChange(defaultValue as number)} disabled={disabled}>
              <RotateCcw />
            </IconButton>
          )}
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={text}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-10 accent-accent cursor-pointer disabled:cursor-not-allowed"
      />
      {description && <p className="text-[12.5px] text-muted">{description}</p>}
    </div>
  );
}

export interface ControlSliderProps {
  spec: ControlSpec;
  value: number | undefined;
  onChange: (value: number) => void;
  disabled?: boolean;
}

/** Slider bound to an engine-declared `ControlSpec` (float/int). Returns null for other control types. */
export function ControlSlider({ spec, value, onChange, disabled }: ControlSliderProps) {
  if (spec.type !== "float" && spec.type !== "int") return null;
  if (spec.min == null || spec.max == null) return null;
  const def = typeof spec.default === "number" ? spec.default : spec.min;
  const step = spec.step ?? (spec.type === "int" ? 1 : 0.01);
  return (
    <Slider
      label={spec.label}
      value={value ?? def}
      onChange={(v) => onChange(spec.type === "int" ? Math.round(v) : v)}
      min={spec.min}
      max={spec.max}
      step={step}
      defaultValue={def}
      description={spec.description}
      disabled={disabled}
    />
  );
}
