import { describe, expect, it } from "vitest";

import { applyCtrl, controlChar, useCtrl } from "./touchKeys";

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
    useCtrl.getState().toggle();
    expect(applyCtrl("c")).toBe("\x03");
    expect(useCtrl.getState().armed).toBe(false);
    expect(applyCtrl("c")).toBe("c");
  });

  it("lets keys without a control character through, and still disarms", () => {
    useCtrl.getState().toggle();
    expect(applyCtrl("1")).toBe("1");
    expect(useCtrl.getState().armed).toBe(false);
  });
});
