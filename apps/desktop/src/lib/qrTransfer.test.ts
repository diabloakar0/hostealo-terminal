import { describe, expect, it } from "vitest";

import { collectQrFrame, formatTransferCode, parseQrFrame, qrComplete } from "./qrTransfer";

const frame = (transfer: string, i: number, n: number, key = "K7QM2XPA") => `hostealo-terminal://qr?s=${transfer}&i=${i}&n=${n}&k=${key}&d=AbC-_9`;

describe("QR transfers", () => {
  it("reads a part of a transfer", () => {
    expect(parseQrFrame(frame("a1b2", 2, 3))).toEqual({ transfer: "a1b2", index: 2, total: 3, needsCode: false });
    expect(parseQrFrame(frame("a1b2", 1, 1, ""))?.needsCode).toBe(true);
  });

  it("ignores other codes", () => {
    expect(parseQrFrame("https://hostealo.com")).toBeNull();
    expect(parseQrFrame("hostealo-terminal://sync?a=1.2.3.4:5&t=x")).toBeNull();
    expect(parseQrFrame(frame("a1b2", 4, 3))).toBeNull();
    expect(parseQrFrame("hostealo-terminal://qr?s=a&i=1&n=1&k=")).toBeNull();
  });

  it("collects the parts in any order, once each", () => {
    let collection = collectQrFrame(null, frame("t", 3, 3));
    collection = collectQrFrame(collection, frame("t", 1, 3));
    const before = collection;
    collection = collectQrFrame(collection, frame("t", 1, 3));
    expect(collection).toBe(before);
    expect(qrComplete(collection)).toBe(false);
    collection = collectQrFrame(collection, "not ours");
    expect(collection).toBe(before);
    collection = collectQrFrame(collection, frame("t", 2, 3));
    expect(qrComplete(collection)).toBe(true);
    expect([...collection!.parts.keys()].sort()).toEqual([1, 2, 3]);
  });

  it("starts over on a part of another transfer", () => {
    let collection = collectQrFrame(null, frame("old", 1, 2));
    collection = collectQrFrame(collection, frame("new", 2, 2));
    expect(collection?.transfer).toBe("new");
    expect(collection?.parts.size).toBe(1);
  });

  it("shows the code in two halves", () => {
    expect(formatTransferCode("K7QM2XPA")).toBe("K7QM-2XPA");
  });
});
