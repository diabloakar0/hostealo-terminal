import { create } from "zustand";

import type { RdpInput } from "./ipc";
import { SCANCODES } from "./scancodes";

/**
 * Remote desktop on a touch screen (iPhone, iPad), as the Microsoft app does it: the device's
 * keyboard on demand, with a row of the keys it lacks, and touch gestures turned into the mouse.
 */

// -- Keyboard -----------------------------------------------------------------------------------

export type Modifier = "ctrl" | "alt" | "win";

const MODIFIER_SCANCODE: Record<Modifier, number> = {
  ctrl: SCANCODES.ControlLeft,
  alt: SCANCODES.AltLeft,
  win: SCANCODES.MetaLeft,
};

/** Keys of the row above the keyboard, sent as scancodes. */
export const RDP_KEYS: { label: string; code: keyof typeof SCANCODES }[] = [
  { label: "Esc", code: "Escape" },
  { label: "Tab", code: "Tab" },
  { label: "Supr", code: "Delete" },
  { label: "←", code: "ArrowLeft" },
  { label: "↓", code: "ArrowDown" },
  { label: "↑", code: "ArrowUp" },
  { label: "→", code: "ArrowRight" },
];

/** Which tab shows the keyboard, and the modifiers armed for the next key. */
export const useRdpKeyboard = create<{
  tabId: string | null;
  armed: Record<Modifier, boolean>;
  setOpen: (tabId: string | null) => void;
  toggle: (modifier: Modifier) => void;
  disarm: () => void;
}>((set) => ({
  tabId: null,
  armed: { ctrl: false, alt: false, win: false },
  setOpen: (tabId) => set({ tabId, armed: { ctrl: false, alt: false, win: false } }),
  toggle: (modifier) => set((s) => ({ armed: { ...s.armed, [modifier]: !s.armed[modifier] } })),
  disarm: () => set({ armed: { ctrl: false, alt: false, win: false } }),
}));

const tap = (scancode: number): RdpInput[] => [
  { type: "key", scancode, pressed: true },
  { type: "key", scancode, pressed: false },
];

/** A key press with the armed modifiers held around it. */
export function withModifiers(key: RdpInput[], armed: Record<Modifier, boolean>): RdpInput[] {
  const held = (Object.keys(MODIFIER_SCANCODE) as Modifier[]).filter((m) => armed[m]).map((m) => MODIFIER_SCANCODE[m]);
  return [
    ...held.map((scancode) => ({ type: "key" as const, scancode, pressed: true })),
    ...key,
    ...held.reverse().map((scancode) => ({ type: "key" as const, scancode, pressed: false })),
  ];
}

/** One of the row's keys, or a key the device keyboard sends by name (Backspace, Enter...). */
export function namedKey(code: string): RdpInput[] | null {
  const scancode = SCANCODES[code];
  return scancode === undefined ? null : tap(scancode);
}

/**
 * Typed text: letters go as scancodes when a modifier is armed (Ctrl then C must be Ctrl+C on
 * the remote, whatever its layout), and as characters otherwise, so accents and symbols arrive
 * as typed whatever the keyboard layouts on both sides.
 */
export function typedText(text: string, armed: Record<Modifier, boolean>): RdpInput[] {
  const anyArmed = armed.ctrl || armed.alt || armed.win;
  if (anyArmed && text.length === 1) {
    const upper = text.toUpperCase();
    const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(text) ? `Digit${text}` : text === " " ? "Space" : null;
    const key = code ? namedKey(code) : null;
    if (key) return withModifiers(key, armed);
  }
  return [...text].flatMap((char) => [
    { type: "unicode" as const, text: char, pressed: true },
    { type: "unicode" as const, text: char, pressed: false },
  ]);
}

// -- Touch gestures -----------------------------------------------------------------------------

/** How long a still finger waits before it is a right click. */
export const LONG_PRESS_MS = 550;
/** How far a finger may wander and still be a tap. */
export const TAP_SLOP = 10;
/** Screen pixels of two-finger travel per wheel notch. */
export const SCROLL_STEP = 24;

type Point = { x: number; y: number };

/**
 * Turns touches into the mouse: a tap is a click, holding still is a right click, dragging one
 * finger holds the left button, two fingers scroll. `remote` maps a screen point to remote
 * desktop pixels.
 */
export function createTouchGestures(send: (ops: RdpInput[]) => void, remote: (p: Point) => Point | null) {
  const fingers = new Map<number, Point>();
  let start: Point | null = null;
  let mode: "pending" | "drag" | "scroll" | "done" = "done";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scrollY = 0;
  let scrolled = 0;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const at = (p: Point) => {
    const r = remote(p);
    return r ? [{ type: "mouseMove" as const, ...r }] : [];
  };
  const click = (p: Point, button: number) =>
    send([...at(p), { type: "mouseButton", button, pressed: true }, { type: "mouseButton", button, pressed: false }]);
  const averageY = () => [...fingers.values()].reduce((sum, f) => sum + f.y, 0) / fingers.size;

  return {
    down(id: number, p: Point) {
      fingers.set(id, p);
      if (fingers.size === 1) {
        start = p;
        mode = "pending";
        clearTimer();
        timer = setTimeout(() => {
          if (mode === "pending" && start) {
            mode = "done";
            click(start, 2);
          }
        }, LONG_PRESS_MS);
      } else if (fingers.size === 2) {
        clearTimer();
        // A drag that turns into a scroll lets go of the button first.
        if (mode === "drag") send([{ type: "mouseButton", button: 0, pressed: false }]);
        mode = "scroll";
        scrollY = averageY();
        scrolled = 0;
      }
    },
    move(id: number, p: Point) {
      if (!fingers.has(id)) return;
      fingers.set(id, p);
      if (mode === "scroll" && fingers.size >= 2) {
        const y = averageY();
        scrolled += y - scrollY;
        scrollY = y;
        const notches = Math.trunc(scrolled / SCROLL_STEP);
        if (notches !== 0) {
          scrolled -= notches * SCROLL_STEP;
          // Fingers moving down pull the content down: scrolling up, as on a phone.
          send([{ type: "wheel", vertical: true, units: notches * 120 }]);
        }
        return;
      }
      if (mode === "pending" && start && Math.hypot(p.x - start.x, p.y - start.y) > TAP_SLOP) {
        clearTimer();
        mode = "drag";
        send([...at(start), { type: "mouseButton", button: 0, pressed: true }]);
      }
      if (mode === "drag") send(at(p));
    },
    up(id: number, p: Point) {
      if (!fingers.delete(id)) return;
      if (fingers.size > 0) return;
      clearTimer();
      if (mode === "pending") click(start ?? p, 0);
      else if (mode === "drag") send([...at(p), { type: "mouseButton", button: 0, pressed: false }]);
      mode = "done";
      start = null;
    },
    cancel() {
      clearTimer();
      if (mode === "drag") send([{ type: "mouseButton", button: 0, pressed: false }]);
      fingers.clear();
      mode = "done";
      start = null;
    },
  };
}
