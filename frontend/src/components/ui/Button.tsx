import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/lib/format";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "soft" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Leading icon (lucide element). */
  icon?: ReactNode;
  /** Trailing icon. */
  iconRight?: ReactNode;
  block?: boolean;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-text hover:bg-accent-hover border border-transparent shadow-sm",
  soft: "bg-accent-soft text-accent hover:bg-accent-soft-hover border border-transparent",
  secondary: "bg-panel text-text border border-border-strong hover:bg-panel-alt",
  ghost: "bg-transparent text-text border border-transparent hover:bg-hover",
  danger: "bg-danger text-white border border-transparent hover:bg-danger-hover",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-[15px] gap-2",
};

/** Standard button. `loading` shows a spinner and disables interaction while keeping the label. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, iconRight, block, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center rounded-[var(--radius-control)] font-medium whitespace-nowrap select-none",
        "transition-colors duration-100 disabled:opacity-55 disabled:cursor-not-allowed",
        variantClass[variant],
        sizeClass[size],
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === "lg" ? 18 : 16} className="shrink-0" /> : icon ? <span className="shrink-0 inline-flex [&>svg]:size-4">{icon}</span> : null}
      {children}
      {iconRight ? <span className="shrink-0 inline-flex [&>svg]:size-4">{iconRight}</span> : null}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (required — there is no visible text). */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

const iconSizeClass: Record<ButtonSize, string> = { sm: "size-9", md: "size-10", lg: "size-12" };

/** Square icon-only button with a mandatory accessible label (also used as the tooltip). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "ghost", size = "md", loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center rounded-[var(--radius-control)] transition-colors duration-100",
        "disabled:opacity-55 disabled:cursor-not-allowed [&>svg]:size-[18px]",
        variantClass[variant],
        iconSizeClass[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : children}
    </button>
  );
});
