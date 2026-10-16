const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number, digits = 1): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : digits)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function percent(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

/** Status colour for a usage percentage, matching the panel's badge colours. */
export function usageTone(value: number): "normal" | "warning" | "critical" {
  if (value >= 90) return "critical";
  if (value >= 70) return "warning";
  return "normal";
}

export const isMac = navigator.userAgent.includes("Mac");

/** iPhone and iPad. iPadOS presents itself as a Mac, so the touch screen tells them apart. */
export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

/** Whether this device can open a shell of its own: iOS does not let apps start processes. */
export const hasLocalShell = !isIOS;
