import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RdpInput } from "./ipc";
import { createTouchGestures, LONG_PRESS_MS, namedKey, SCROLL_STEP, typedText, withModifiers } from "./rdpTouch";
import { SCANCODES } from "./scancodes";

const none = { ctrl: false, alt: false, win: false };

describe("remote desktop keyboard", () => {
  it("sends typed characters as they are, accents included", () => {
    expect(typedText("ñ", none)).toEqual([
      { type: "unicode", text: "ñ", pressed: true },
      { type: "unicode", text: "ñ", pressed: false },
    ]);
    expect(typedText("ab", none)).toHaveLength(4);
  });

  it("turns Ctrl then a letter into Ctrl+letter scancodes", () => {
    expect(typedText("c", { ...none, ctrl: true })).toEqual([
      { type: "key", scancode: SCANCODES.ControlLeft, pressed: true },
      { type: "key", scancode: SCANCODES.KeyC, pressed: true },
      { type: "key", scancode: SCANCODES.KeyC, pressed: false },
      { type: "key", scancode: SCANCODES.ControlLeft, pressed: false },
    ]);
  });

  it("holds several modifiers and releases them in reverse", () => {
    const ops = withModifiers(namedKey("Delete")!, { ctrl: true, alt: true, win: false });
    expect(ops.map((op) => (op.type === "key" ? [op.scancode, op.pressed] : null))).toEqual([
      [SCANCODES.ControlLeft, true],
      [SCANCODES.AltLeft, true],
      [SCANCODES.Delete, true],
      [SCANCODES.Delete, false],
      [SCANCODES.AltLeft, false],
      [SCANCODES.ControlLeft, false],
    ]);
  });

  it("knows the named keys the device keyboard sends", () => {
    expect(namedKey("Backspace")).toHaveLength(2);
    expect(namedKey("Enter")).toHaveLength(2);
    expect(namedKey("Unidentified")).toBeNull();
  });
});

describe("remote desktop touch gestures", () => {
  let sent: RdpInput[];
  let touch: ReturnType<typeof createTouchGestures>;
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    touch = createTouchGestures((ops) => sent.push(...ops), (p) => ({ x: p.x * 2, y: p.y * 2 }));
  });
  afterEach(() => vi.useRealTimers());

  const buttons = () => sent.filter((op) => op.type === "mouseButton").map((op) => op.type === "mouseButton" && [op.button, op.pressed]);

  it("clicks on a tap, where the finger landed", () => {
    touch.down(1, { x: 10, y: 20 });
    touch.up(1, { x: 11, y: 21 });
    expect(sent[0]).toEqual({ type: "mouseMove", x: 20, y: 40 });
    expect(buttons()).toEqual([
      [0, true],
      [0, false],
    ]);
  });

  it("right-clicks when the finger stays still", () => {
    touch.down(1, { x: 10, y: 20 });
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    touch.up(1, { x: 10, y: 20 });
    expect(buttons()).toEqual([
      [2, true],
      [2, false],
    ]);
  });

  it("holds the left button while dragging", () => {
    touch.down(1, { x: 10, y: 10 });
    touch.move(1, { x: 40, y: 10 });
    touch.move(1, { x: 60, y: 10 });
    touch.up(1, { x: 60, y: 10 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(buttons()).toEqual([
      [0, true],
      [0, false],
    ]);
    expect(sent.at(-2)).toEqual({ type: "mouseMove", x: 120, y: 20 });
  });

  it("scrolls with two fingers and never clicks", () => {
    touch.down(1, { x: 10, y: 100 });
    touch.down(2, { x: 50, y: 100 });
    touch.move(1, { x: 10, y: 100 + SCROLL_STEP * 2 });
    touch.move(2, { x: 50, y: 100 + SCROLL_STEP * 2 });
    touch.up(1, { x: 10, y: 150 });
    touch.up(2, { x: 50, y: 150 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(buttons()).toEqual([]);
    const wheel = sent.filter((op) => op.type === "wheel").reduce((sum, op) => sum + (op.type === "wheel" ? op.units : 0), 0);
    expect(wheel).toBe(240);
  });
});
