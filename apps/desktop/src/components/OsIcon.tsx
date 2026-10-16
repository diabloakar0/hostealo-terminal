import { osIcon, isDarkBrand } from "@hostealo/ui/os-icons";
import { cn } from "@hostealo/ui/cn";

import { useResolvedTheme } from "../hooks/usePreferences";
import type { Host } from "../lib/ipc";

/** The logo for a host's system: detected over SSH, Windows for RDP until something else is seen. */
export function hostOsId(host: Pick<Host, "os" | "protocol">): string | null {
  return host.os?.id ?? (host.protocol === "rdp" ? "windows" : null);
}

interface OsIconProps {
  id: string;
  /** Overrides the brand colour (the host's colour tag). */
  color?: string;
  className?: string;
}

/** An operating system logo, in its brand colour unless `color` is given. */
export function OsIcon({ id, color, className }: OsIconProps) {
  const theme = useResolvedTheme();
  const icon = osIcon(id);
  if (!icon) return null;
  // In the dark theme, near-black logos (Apple, AlmaLinux) take the text colour to stay visible.
  const fill = color ?? (theme === "dark" && isDarkBrand(icon.hex) ? "currentColor" : `#${icon.hex}`);
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label={icon.title} className={cn("size-4 shrink-0", className)} fill={fill}>
      <title>{icon.title}</title>
      <path d={icon.path} />
    </svg>
  );
}
