// Per-host colours. A session to a coloured host tints the terminal, so you can tell at a glance
// whether you are typing into production. Values come from the panel v2 palette.
import type { TerminalTheme } from "./terminal-themes";

export const HOST_COLORS = {
  red: { light: "#dc2626", dark: "#f87171" },
  orange: { light: "#ea580c", dark: "#fb923c" },
  amber: { light: "#d97706", dark: "#fbbf24" },
  green: { light: "#16a34a", dark: "#4ade80" },
  cyan: { light: "#0891b2", dark: "#22d3ee" },
  blue: { light: "#2563eb", dark: "#60a5fa" },
  indigo: { light: "#5350f2", dark: "#7c7aff" },
  purple: { light: "#7c3aed", dark: "#a78bfa" },
  pink: { light: "#db2777", dark: "#f472b6" },
} as const;

export type HostColor = keyof typeof HOST_COLORS;
/** `none` keeps the plain terminal theme. */
export type HostColorSetting = HostColor | "none";

/** Colour used when a host has none set: SSH sessions always look different from local ones. */
export const DEFAULT_HOST_COLOR: HostColor = "indigo";

export function resolveHostColor(setting: string | null | undefined): HostColor | null {
  if (setting === "none") return null;
  return setting && setting in HOST_COLORS ? (setting as HostColor) : DEFAULT_HOST_COLOR;
}

export function hostColorHex(color: HostColor, theme: "dark" | "light"): string {
  return HOST_COLORS[color][theme];
}

function mix(base: string, tint: string, amount: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [parse(base), parse(tint)];
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The terminal theme with its background, cursor and selection tinted towards the host colour. */
export function tintTerminalTheme(theme: TerminalTheme, color: HostColor, mode: "dark" | "light"): TerminalTheme {
  const hex = hostColorHex(color, mode);
  return {
    ...theme,
    background: mix(theme.background, hex, mode === "dark" ? 0.09 : 0.05),
    cursor: hex,
    selectionBackground: withAlpha(hex, mode === "dark" ? 0.32 : 0.22),
  };
}
