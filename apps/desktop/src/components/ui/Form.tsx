import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

/** Mirrors the panel's .input. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      className={cn(
        "h-9 w-full min-w-0 rounded-btn border border-input-border bg-input px-3 text-sm text-fg shadow-sm outline-none transition-[border-color,box-shadow]",
        "select-text placeholder:text-fg-muted/70 focus:border-fg-muted focus:ring-4 focus:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
});

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: (id: string) => ReactNode;
}

export function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-red">{error}</p> : hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
}

export function Segmented<T extends string>({ value, onChange, options }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" className="grid auto-cols-fr grid-flow-col gap-1 rounded-btn border border-border bg-deep p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-btn-sm text-[13px] font-medium transition-colors",
            value === option.value ? "bg-card text-fg shadow-sm ring-1 ring-border" : "text-fg-muted hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-secondary">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={cn(
          "grid size-4 place-items-center rounded-[4px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent",
          checked ? "border-accent-button bg-accent-button text-white" : "border-input-border bg-input",
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      {children}
    </label>
  );
}
