import { cn } from "@hostealo/ui/cn";

import type { TabStatus } from "../store/tabs";

// The panel's status dots (.v2-dot-*), which carry a soft halo.
const DOTS: Record<TabStatus, string> = {
  connecting: "v2-dot-amber animate-pulse",
  authenticating: "v2-dot-amber animate-pulse",
  connected: "v2-dot-green",
  closed: "v2-dot-grey",
  failed: "v2-dot-red",
};

const SEVERITY: Record<TabStatus, number> = { closed: 0, connected: 1, connecting: 2, authenticating: 2, failed: 3 };

/** The status to show for a group: its most severe member, like the panel's rolled-up dots. */
export function worstStatus(statuses: Iterable<TabStatus | undefined>): TabStatus | undefined {
  let worst: TabStatus | undefined;
  for (const status of statuses) {
    if (status && (worst === undefined || SEVERITY[status] > SEVERITY[worst])) worst = status;
  }
  return worst;
}

export function StatusDot({ status, small, className }: { status: TabStatus; small?: boolean; className?: string }) {
  return <span aria-hidden className={cn("v2-dot", small && "v2-dot-sm", DOTS[status], className)} />;
}
