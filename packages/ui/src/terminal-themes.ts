// xterm.js colour schemes derived from the Hostealo panel v2 palette.
// The structure matches xterm's ITheme so the object can be passed straight to `terminal.options.theme`.

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const hostealoDark: TerminalTheme = {
  background: "#09090b",
  foreground: "#fafafa",
  cursor: "#7c7aff",
  cursorAccent: "#09090b",
  selectionBackground: "rgba(124, 122, 255, 0.32)",
  black: "#27272a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#a78bfa",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#71717a",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

export const hostealoLight: TerminalTheme = {
  background: "#ffffff",
  foreground: "#09090b",
  cursor: "#5350f2",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(83, 80, 242, 0.2)",
  black: "#09090b",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#b45309",
  blue: "#2563eb",
  magenta: "#7c3aed",
  cyan: "#0891b2",
  white: "#a1a1aa",
  brightBlack: "#52525b",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#d97706",
  brightBlue: "#3b82f6",
  brightMagenta: "#8b5cf6",
  brightCyan: "#06b6d4",
  brightWhite: "#3f3f46",
};
