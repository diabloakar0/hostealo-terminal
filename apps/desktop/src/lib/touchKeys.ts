import { create } from "zustand";

/**
 * The keys an on-screen keyboard lacks, for terminals on touch screens (iPhone, iPad): Esc,
 * Tab, the arrows, and Ctrl, which stays armed until the next key and turns it into its
 * control character (Ctrl then C sends ^C).
 */
export const TOUCH_KEYS: { label: string; data: string; aria?: string }[] = [
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
];

export const useCtrl = create<{ armed: boolean; toggle: () => void; disarm: () => void }>((set) => ({
  armed: false,
  toggle: () => set((s) => ({ armed: !s.armed })),
  disarm: () => set({ armed: false }),
}));

/** The control character for `key` (a letter or one of @[\]^_ and space), if it has one. */
export function controlChar(key: string): string | null {
  if (key.length !== 1) return null;
  if (key === " ") return "\x00";
  const code = key.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
}

/** Typed input, with Ctrl applied to it when the touch Ctrl key is armed. */
export function applyCtrl(data: string): string {
  const ctrl = useCtrl.getState();
  if (!ctrl.armed) return data;
  ctrl.disarm();
  return controlChar(data) ?? data;
}
