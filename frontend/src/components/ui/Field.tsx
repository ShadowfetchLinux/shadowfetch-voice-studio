import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "@/lib/format";

interface FieldChrome {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
}

/** Label + control + hint/error wrapper shared by Input / Select / Textarea. */
export function FieldWrap({ id, label, hint, error, className, children }: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className={cx("flex flex-col gap-1.5 min-w-0", className)}>
      {label && (
        <label htmlFor={id} className="text-[13px] font-medium text-text">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12.5px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className">, FieldChrome {
  /** Extra classes for the <input> itself. */
  inputClassName?: string;
  /** Text shown inside the field on the right (unit). */
  suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, className, inputClassName, suffix, id, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldWrap id={fid} label={label} hint={hint} error={error} className={className}>
      <div className="relative">
        <input
          ref={ref}
          id={fid}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
          className={cx("field-input control", suffix ? "pr-14" : null, inputClassName)}
          {...rest}
        />
        {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-muted pointer-events-none">{suffix}</span>}
      </div>
    </FieldWrap>
  );
});

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">, FieldChrome {
  textareaClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, className, textareaClassName, id, rows = 4, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldWrap id={fid} label={label} hint={hint} error={error} className={className}>
      <textarea
        ref={ref}
        id={fid}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
        className={cx("field-input py-2.5 leading-relaxed resize-y min-h-[80px]", textareaClassName)}
        {...rest}
      />
    </FieldWrap>
  );
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className">, FieldChrome {
  options: SelectOption[];
  placeholder?: string;
  selectClassName?: string;
}

/** Native <select> styled to match inputs (keyboard + screen-reader behaviour comes for free). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, hint, error, className, selectClassName, options, placeholder, id, value, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldWrap id={fid} label={label} hint={hint} error={error} className={className}>
      <div className="relative">
        <select
          ref={ref}
          id={fid}
          {...(value !== undefined ? { value } : {})}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
          className={cx("field-input control appearance-none pr-9 cursor-pointer", selectClassName)}
          {...rest}
        >
          {placeholder && (
            <option value="" disabled={rest.required}>
              {placeholder}
            </option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted pointer-events-none" aria-hidden />
      </div>
    </FieldWrap>
  );
});
