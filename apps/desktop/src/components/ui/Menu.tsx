import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@hostealo/ui/cn";

export type MenuEntry =
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; hint?: string }
  | { separator: true }
  | { heading: string }
  | { content: ReactNode };

export type MenuAnchor =
  /** Context menu at the mouse position. */
  | { x: number; y: number }
  /** Dropdown attached to an element. */
  | { rect: DOMRect; placement: "below" | "above" | "right" };

interface MenuProps {
  anchor: MenuAnchor;
  entries: MenuEntry[];
  onClose: () => void;
  className?: string;
}

const MARGIN = 8;

/** Floating menu with the panel's dropdown style. Closes on outside click, Esc, resize or blur. */
export function Menu({ anchor, entries, onClose, className }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Place it, then keep it inside the window.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    let left: number;
    let top: number;
    if ("x" in anchor) {
      left = anchor.x;
      top = anchor.y;
    } else if (anchor.placement === "right") {
      left = anchor.rect.right + 4;
      top = anchor.rect.top;
    } else {
      left = anchor.rect.left;
      top = anchor.placement === "below" ? anchor.rect.bottom + 4 : anchor.rect.top - height - 4;
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
    setPosition({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Arrow keys move between items.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={position ?? { left: -9999, top: -9999 }}
      className={cn("v2-menu fixed z-[60] min-w-52 rounded-lg p-1 text-sm", className)}
    >
      {entries.map((entry, index) => {
        if ("separator" in entry) return <div key={index} className="my-1 h-px bg-border" />;
        if ("heading" in entry)
          return (
            <p key={index} className="px-2 py-1.5 text-xs text-fg-muted">
              {entry.heading}
            </p>
          );
        if ("content" in entry) return <div key={index}>{entry.content}</div>;
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
            className={cn(
              "v2-nav-link flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:bg-muted",
              entry.danger && "hover:!text-red focus-visible:!text-red",
            )}
          >
            {entry.icon && <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{entry.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint && <span className="text-xs text-fg-muted">{entry.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
