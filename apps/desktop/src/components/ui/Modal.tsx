import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { Button } from "./Button";

interface ModalProps {
  title: ReactNode;
  /** Small icon tile shown before the title. */
  icon?: ReactNode;
  tone?: "default" | "danger";
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Centered dialog with the panel's card style. Esc and a click outside close it. */
export function Modal({ title, icon, tone = "default", onClose, children, footer, className }: ModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Give focus back to whatever had it (usually the terminal) when the dialog goes away.
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const firstField = dialog?.querySelector<HTMLElement>("input:not([disabled]), [data-autofocus]");
    (firstField ?? dialog)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-card border border-border bg-card shadow-md outline-none",
          className,
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          {icon && (
            <div
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-btn",
                tone === "danger" ? "bg-red/10 text-red" : "bg-badge text-accent",
              )}
            >
              {icon}
            </div>
          )}
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold text-fg">
            {title}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("common.close")}>
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-5">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-border bg-deep px-5 py-3 rounded-b-card">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
