import type { ReactNode } from "react";
import { cn } from "@hostealo/ui/cn";

interface PageProps {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Layout for non-terminal tabs (keys, known hosts...), like a panel page. */
export function Page({ icon, title, description, actions, children, className }: PageProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn("mx-auto flex max-w-5xl flex-col gap-6 px-8 py-8", className)}>
        <header className="flex items-start gap-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-card-deep bg-badge text-accent">{icon}</div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-fg">{title}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-muted">{description}</p>
          </div>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

export function Badge({ children, tone = "default", className }: { children: ReactNode; tone?: "default" | "info" | "warning" | "success"; className?: string }) {
  // Mirrors the panel's .badge, .badge-info, .badge-pending and .badge-active.
  const tones = {
    default: "border-border text-fg-secondary",
    info: "border-accent/25 bg-badge text-accent",
    warning: "border-amber/25 bg-amber/10 text-amber",
    success: "border-green/25 bg-green/10 text-green",
  };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-badge border px-2 py-px text-xs font-medium whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}
