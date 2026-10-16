import { describe, expect, it } from "vitest";

import { matches } from "./search";

describe("palette search", () => {
  it("finds every word in any order, ignoring accents and case", () => {
    expect(matches("prod web", "web-01 Producción · root@203.0.113.10")).toBe(true);
    expect(matches("PRODUCCION", "web-01 Producción")).toBe(true);
    expect(matches("sesion", "Ir a la sesión")).toBe(true);
    expect(matches("web mysql", "web-01 Producción")).toBe(false);
    expect(matches("", "anything")).toBe(true);
  });
});
