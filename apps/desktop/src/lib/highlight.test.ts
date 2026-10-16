import { describe, expect, it } from "vitest";

import { OutputHighlighter, highlightText } from "./highlight";

const bytes = (s: string) => new TextEncoder().encode(s);
/** Removes colour codes, to check the visible text never changes. */
const plain = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");
/** Tokens wrapped in a colour code, in order. */
const coloured = (s: string) => [...s.matchAll(/\x1b\[([\d;]+)m([^\x1b]*)\x1b\[[\d;]+m/g)].map((m) => [m[1], m[2]]);

describe("highlightText", () => {
  it("colours a tcpdump line without changing its text", () => {
    const line = "12:34:56.789012 IP 10.0.0.1.22 > 192.168.1.20.51234: Flags [P.], length 36";
    const out = highlightText(line);
    expect(plain(out)).toBe(line);
    expect(coloured(out)).toEqual([
      ["34", "12:34:56.789012"],
      ["36", "10.0.0.1"],
      ["36", "192.168.1.20"],
    ]);
  });

  it("recognises errors, warnings, success words, MACs, IPv6, URLs and sizes", () => {
    const out = highlightText(
      "Error: connection refused; warning: retrying; OK. link/ether 52:54:00:12:34:56 inet6 fe80::1/64 https://hostealo.es 1.5 GiB",
    );
    expect(coloured(out).map(([, token]) => token)).toEqual([
      "Error",
      "refused",
      "warning",
      "retrying",
      "OK",
      "52:54:00:12:34:56",
      "fe80::1/64",
      "https://hostealo.es",
      "1.5 GiB",
    ]);
  });

  it("does not colour words that only contain a keyword", () => {
    expect(coloured(highlightText("terror okay unknown errorless"))).toEqual([]);
    expect(coloured(highlightText("999.1.1.1 1.2.3"))).toEqual([]);
  });
});

describe("OutputHighlighter", () => {
  it("leaves text that the program already coloured alone, and resumes after a reset", () => {
    const h = new OutputHighlighter();
    const input = "\x1b[01;34merror 10.0.0.1\x1b[0m then 10.0.0.2";
    const out = h.process(bytes(input), true);
    expect(out.startsWith("\x1b[01;34merror 10.0.0.1\x1b[0m then ")).toBe(true);
    expect(coloured(out.slice(input.indexOf(" then")))).toEqual([["36", "10.0.0.2"]]);
  });

  it("never touches full-screen programs (alternate screen)", () => {
    const h = new OutputHighlighter();
    const inside = "\x1b[?1049h\x1b[H CPU 10.0.0.1 error";
    expect(h.process(bytes(inside), true)).toBe(inside);
    expect(h.process(bytes("still 10.0.0.1"), true)).toBe("still 10.0.0.1");
    const out = h.process(bytes("\x1b[?1049lback 10.0.0.1"), true);
    expect(coloured(out)).toEqual([["36", "10.0.0.1"]]);
  });

  it("handles escape sequences split across chunks", () => {
    const h = new OutputHighlighter();
    expect(h.process(bytes("\x1b[3"), true)).toBe("\x1b[3");
    // The split sequence was a red foreground, so this text stays untouched.
    expect(h.process(bytes("1mfailed 10.0.0.1"), true)).toBe("1mfailed 10.0.0.1");
  });

  it("does not highlight inside window titles (OSC)", () => {
    const h = new OutputHighlighter();
    const title = "\x1b]0;root@web: tail error.log 10.0.0.1\x07";
    expect(h.process(bytes(title), true)).toBe(title);
  });

  it("decodes UTF-8 characters split across chunks", () => {
    const h = new OutputHighlighter();
    const encoded = bytes("Conexión ñ ✓");
    const cut = 9; // in the middle of "ó"
    expect(h.process(encoded.slice(0, cut), true) + h.process(encoded.slice(cut), true)).toBe("Conexión ñ ✓");
  });

  it("passes everything through untouched when disabled", () => {
    const h = new OutputHighlighter();
    expect(h.process(bytes("error at 10.0.0.1"), false)).toBe("error at 10.0.0.1");
  });

  it("treats 256-colour and truecolour foregrounds as coloured text", () => {
    const h = new OutputHighlighter();
    expect(h.process(bytes("\x1b[38;5;196merror\x1b[39m"), true)).toBe("\x1b[38;5;196merror\x1b[39m");
    expect(h.process(bytes("\x1b[48;2;1;2;3merror"), true)).toContain("\x1b[1;31merror");
  });
});
