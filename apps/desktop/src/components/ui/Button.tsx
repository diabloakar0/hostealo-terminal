import type { ButtonHTMLAttributes } from "react";
import { cn } from "@hostealo/ui/cn";

// Mirrors the panel's .btn-primary / .btn-secondary / .btn-ghost / .btn-sm.
const VARIANTS = {
  primary:
    "bg-accent-button text-white border border-transparent shadow-sm hover:bg-accent-button-hover",
  secondary: "bg-card text-fg border border-border shadow-sm hover:bg-muted",
  ghost: "text-fg-secondary hover:bg-muted hover:text-fg",
} as const;

const SIZES = {
  md: "h-9 px-4 text-sm rounded-btn gap-2",
  sm: "h-8 px-3 text-[13px] rounded-btn-sm gap-1.5",
  icon: "size-7 rounded-btn-sm",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
}

export function Button({ variant = "secondary", size = "md", className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
