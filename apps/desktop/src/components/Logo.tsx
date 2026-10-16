import { cn } from "@hostealo/ui/cn";

/** Hostealo brand mark: white rhombus on a near-black tile, identical in both themes (as in the panel). */
export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("grid size-8 shrink-0 place-items-center rounded-btn bg-logo text-white", className)}>
      <svg viewBox="0 0 39.5239 40" className="size-[55%]" fill="currentColor" aria-hidden>
        <path d="M13.1762 0H0V13.335H13.1762V0Z" />
        <path d="M39.5239 26.665H26.3477V40H39.5239V26.665Z" />
        <path d="M39.5239 0H26.3477V13.335H13.1762L0 26.665V40H13.1762V26.665H26.3477L39.5239 13.335V0Z" />
      </svg>
    </div>
  );
}
