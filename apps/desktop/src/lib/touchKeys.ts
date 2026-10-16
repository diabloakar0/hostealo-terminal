import { create } from "zustand";

/**
 * The keys an on-screen keyboard lacks, for terminals on touch screens (iPhone, iPad): Esc,
 * Tab, the arrows, Home/End, the page keys and F1–F12, plus Ctrl and Alt, which stay armed until
 * the next key: Ctrl turns it into its control character (Ctrl then C sends ^C) and Alt sends it
 * with the Escape prefix terminals read as Alt/Meta (Alt then B moves back a word in bash).
 *
 * `name`: a key whose label is a word, translated as `terminal.key.<name>`.
 */
export const TOUCH_KEYS: { label: string; data: string; aria?: string; name?: string }[] = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "←", data: "\x1b[D", aria: "Left" },
  { label: "↓", data: "\x1b[B", aria: "Down" },
  { label: "↑", data: "\x1b[A", aria: "Up" },
  { label: "→", data: "\x1b[C", aria: "Right" },
  { label: "|", data: "|" },
  { label: "/", data: "/" },
  { label: "-", data: "-" },
  { label: "~", data: "~" },
  { label: "Home", data: "\x1b[H", name: "home" },
  { label: "End", data: "\x1b[F", name: "end" },
  { label: "PgUp", data: "\x1b[5~", name: "pageUp" },
  { label: "PgDn", data: "\x1b[6~", name: "pageDown" },
  ...["\x1bOP", "\x1bOQ", "\x1bOR", "\x1bOS", "\x1b[15~", "\x1b[17~", "\x1b[18~", "\x1b[19~", "\x1b[20~", "\x1b[21~", "\x1b[23~", "\x1b[24~"].map(
    (data, i) => ({ label: `F${i + 1}`, data }),
  ),
];

type Armed = { ctrl: boolean; alt: boolean };

export const useTouchModifiers = create<Armed & { toggle: (key: keyof Armed) => void; disarm: () => void }>((set) => ({
  ctrl: false,
  alt: false,
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<Armed>),
  disarm: () => set({ ctrl: false, alt: false }),
}));

/** The control character for `key` (a letter or one of @[\]^_ and space), if it has one. */
export function controlChar(key: string): string | null {
  if (key.length !== 1) return null;
  if (key === " ") return "\x00";
  const code = key.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
}

/** `data` with the armed modifiers applied: Ctrl to a single key, Alt as an Escape prefix. */
export function withTouchModifiers(data: string, armed: Armed): string {
  let out = data;
  if (armed.ctrl) out = controlChar(data) ?? data;
  if (armed.alt) out = `\x1b${out}`;
  return out;
}

/** Typed input, with the touch Ctrl and Alt applied when armed (then cleared). */
export function applyTouchModifiers(data: string): string {
  const state = useTouchModifiers.getState();
  if (!state.ctrl && !state.alt) return data;
  state.disarm();
  return withTouchModifiers(data, state);
}
