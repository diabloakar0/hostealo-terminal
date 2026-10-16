import { hostColorHex, resolveHostColor, type HostColor } from "@hostealo/ui/host-colors";

import { useHosts } from "../store/hosts";
import { useResolvedTheme } from "./usePreferences";

export interface HostAccent {
  color: HostColor;
  /** The colour for the current light/dark theme. */
  hex: string;
}

/** Accent of an SSH host, or `null` for local sessions and hosts set to "none". */
export function useHostAccent(hostId: string | null): HostAccent | null {
  const theme = useResolvedTheme();
  const setting = useHosts((s) => (hostId ? s.hosts.find((h) => h.id === hostId)?.color : undefined));
  if (!hostId) return null;
  const color = resolveHostColor(setting);
  return color ? { color, hex: hostColorHex(color, theme) } : null;
}
