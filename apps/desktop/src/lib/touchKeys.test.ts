import { describe, expect, it } from "vitest";

import { applyTouchModifiers, controlChar, TOUCH_KEYS, useTouchModifiers, withTouchModifiers } from "./touchKeys";

describe("touch keys", () => {
  it("turns letters and a few symbols into control characters", () => {
    expect(controlChar("c")).toBe("\x03");
    expect(controlChar("D")).toBe("\x04");
    expect(controlChar("[")).toBe("\x1b");
    expect(controlChar(" ")).toBe("\x00");
    expect(controlChar("1")).toBeNull();
    expect(controlChar("ab")).toBeNull();
  });

  it("applies Ctrl to the next key only", () => {
    useTouchModifiers.getState().toggle("ctrl");
    expect(applyTouchModifiers("c")).toBe("\x03");
    expect(useTouchModifiers.getState().ctrl).toBe(false);
    expect(applyTouchModifiers("c")).toBe("c");
  });

  it("sends Alt as an Escape prefix, and both together", () => {
    expect(withTouchModifiers("b", { ctrl: false, alt: true })).toBe("\x1bb");
    expect(withTouchModifiers("x", { ctrl: true, alt: true })).toBe("\x1b\x18");
  });

  it("lets keys without a control character through, and still disarms", () => {
    useTouchModifiers.getState().toggle("ctrl");
    expect(applyTouchModifiers("1")).toBe("1");
    expect(useTouchModifiers.getState().ctrl).toBe(false);
  });

  it("has the function keys in order", () => {
    const f = TOUCH_KEYS.filter((key) => /^F\d+$/.test(key.label));
    expect(f.map((key) => key.label)).toEqual(Array.from({ length: 12 }, (_, i) => `F${i + 1}`));
    expect(f[0].data).toBe("\x1bOP");
    expect(f[11].data).toBe("\x1b[24~");
  });
});
