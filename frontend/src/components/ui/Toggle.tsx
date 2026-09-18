import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cx } from "@/lib/format";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Put the switch on the right (settings rows) instead of the left. */
  align?: "left" | "right";
  className?: string;
}

/** Accessible on/off switch (role="switch") with label and optional description. */
export function Switch({ checked, onChange, label, description, disabled, align = "right", className }: SwitchProps) {
  const id = useId();
  const knob = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-describedby={description ? `${id}-desc` : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative shrink-0 w-11 h-6 rounded-full transition-colors duration-150 disabled:opacity-55 disabled:cursor-not-allowed",
        checked ? "bg-accent" : "bg-border-strong",
      )}
    >
      <span
        aria-hidden
        className={cx("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-150", checked && "translate-x-5")}
      />
    </button>
  );
  const text = (
    <label htmlFor={id} className={cx("min-w-0 flex-1 cursor-pointer", disabled && "opacity-60 cursor-not-allowed")}>
      <span className="block text-sm font-medium">{label}</span>
      {description && (
        <span id={`${id}-desc`} className="block text-[12.5px] text-muted mt-0.5">
          {description}
        </span>
      )}
    </label>
  );
  return (
    <div className={cx("flex items-start gap-3 min-h-10", className)}>
      {align === "left" ? (
        <>
          {knob}
          {text}
        </>
      ) : (
        <>
          {text}
          {knob}
        </>
      )}
    </div>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Native checkbox with a custom box; keeps native keyboard/form semantics. */
export function Checkbox({ checked, onChange, label, description, disabled, className }: CheckboxProps) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx("flex items-start gap-3 min-h-10 py-1 cursor-pointer", disabled && "opacity-60 cursor-not-allowed", className)}>
      <span className="relative mt-0.5 shrink-0">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={cx(
            "flex items-center justify-center size-5 rounded-[5px] border transition-colors",
            "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-2",
            checked ? "bg-accent border-accent text-white" : "bg-panel border-border-strong",
          )}
        >
          {checked && <Check className="size-3.5" strokeWidth={3} />}
        </span>
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-[12.5px] text-muted mt-0.5">{description}</span>}
      </span>
    </label>
  );
}
