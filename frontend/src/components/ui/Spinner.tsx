import { cx } from "@/lib/format";

export interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

/** Rotating ring; inherits `currentColor`. */
export function Spinner({ size = 16, className, label = "Loading" }: SpinnerProps) {
  return (
    <svg
      role="status"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cx("animate-[sfvs-spin_0.8s_linear_infinite]", className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
