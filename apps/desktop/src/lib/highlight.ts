// Output highlighting, like MobaXterm or WindTerm: IP addresses, errors, dates... get colours in
// plain command output (tcpdump, journalctl, ping...).
//
// The highlighter sits between the session and xterm.js and only touches plain text:
// - escape sequences pass through untouched, even when split across chunks;
// - text a program already coloured (ls --color, prompts) is left alone;
// - full-screen programs (htop, nload, vim) use the alternate screen and are never touched.
// Colours are ANSI palette indices, so they follow the terminal theme.

interface Rule {
  pattern: string;
  /** SGR parameters to turn the style on, and to turn it off again. */
  on: string;
  off: string;
}

const RULES: Rule[] = [
  { pattern: String.raw`\b(?:https?|ftp)://[^\s"'<>]+`, on: "34;4", off: "39;24" },
  { pattern: String.raw`\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b`, on: "95", off: "39" },
  {
    pattern: String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:/\d{1,2})?(?::\d{1,5})?\b`,
    on: "36",
    off: "39",
  },
  {
    pattern: String.raw`\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b`,
    on: "34",
    off: "39",
  },
  {
    // Full form, or compressed with "::". Not preceded or followed by word characters or colons.
    pattern: String.raw`(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?:/\d{1,3})?(?![\w:])`,
    on: "36",
    off: "39",
  },
  {
    pattern: String.raw`\b(?:errors?|err|fail(?:ed|ure|s)?|fatal|critical|crit|emerg|denied|refused|unreachable|timed out|timeout|panic|killed|segfault|invalid|not found|no such file or directory|aborted|unable|cannot|can't)\b`,
    on: "1;31",
    off: "22;39",
  },
  { pattern: String.raw`\b(?:warnings?|warn|deprecated|retrying|retry|degraded)\b`, on: "33", off: "39" },
  {
    pattern: String.raw`\b(?:ok|success(?:ful(?:ly)?)?|succeeded|active|running|enabled|listening|listen|established|connected|done|passed|healthy|online)\b`,
    on: "32",
    off: "39",
  },
  { pattern: String.raw`\b\d+(?:[.,]\d+)?\s?(?:[kmgtp]i?b|[kmg]bit/s|[kmg]b/s|bytes?)\b`, on: "35", off: "39" },
];

const COMBINED = new RegExp(RULES.map((r) => `(${r.pattern})`).join("|"), "gi");

/** Adds colour codes around interesting tokens of a plain text run (no escape sequences inside). */
export function highlightText(text: string): string {
  return text.replace(COMBINED, (match, ...groups) => {
    const index = groups.findIndex((g, i) => i < RULES.length && g !== undefined);
    const rule = RULES[index];
    return rule ? `\x1b[${rule.on}m${match}\x1b[${rule.off}m` : match;
  });
}

type ParserState = "ground" | "escape" | "escapeIntermediate" | "csi" | "osc" | "string" | "stringEscape";

/** Stateful filter for one terminal session. */
export class OutputHighlighter {
  private decoder = new TextDecoder();
  private state: ParserState = "ground";
  private csi = "";
  /** The program has set a foreground colour that is still active. */
  private coloured = false;
  private alternateScreen = false;

  /** Returns the chunk as text, with highlighting added when `enabled`. */
  process(chunk: Uint8Array, enabled: boolean): string {
    const text = this.decoder.decode(chunk, { stream: true });
    let output = "";
    let run = "";
    const flush = () => {
      if (run) output += enabled && !this.coloured && !this.alternateScreen ? highlightText(run) : run;
      run = "";
    };

    for (const char of text) {
      const code = char.charCodeAt(0);
      switch (this.state) {
        case "ground":
          if (char === "\x1b") {
            flush();
            this.state = "escape";
            output += char;
          } else {
            run += char;
          }
          continue;
        case "escape":
          output += char;
          if (char === "[") {
            this.state = "csi";
            this.csi = "";
          } else if (char === "]") {
            this.state = "osc";
          } else if ("PX^_".includes(char)) {
            this.state = "string";
          } else if (code >= 0x20 && code <= 0x2f) {
            this.state = "escapeIntermediate";
          } else {
            this.state = "ground";
          }
          continue;
        case "escapeIntermediate":
          output += char;
          if (code >= 0x30) this.state = "ground";
          continue;
        case "csi":
          output += char;
          if (code >= 0x40 && code <= 0x7e) {
            this.handleCsi(this.csi, char);
            this.state = "ground";
          } else {
            this.csi += char;
          }
          continue;
        case "osc":
          output += char;
          // Ends with BEL or ESC \.
          if (char === "\x07") this.state = "ground";
          else if (char === "\x1b") this.state = "stringEscape";
          continue;
        case "string":
          output += char;
          if (char === "\x1b") this.state = "stringEscape";
          continue;
        case "stringEscape":
          output += char;
          this.state = "ground";
          continue;
      }
    }
    flush();
    return output;
  }

  private handleCsi(params: string, final: string) {
    if (final === "m") {
      this.applySgr(params);
    } else if ((final === "h" || final === "l") && params.startsWith("?")) {
      const modes = params.slice(1).split(";");
      if (modes.some((m) => m === "1049" || m === "1047" || m === "47")) this.alternateScreen = final === "h";
    }
  }

  private applySgr(params: string) {
    const values = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === 0 || value === 39) this.coloured = false;
      else if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) this.coloured = true;
      else if (value === 38 || value === 48) {
        if (value === 38) this.coloured = true;
        // Skip the colour arguments: 5;n or 2;r;g;b.
        i += values[i + 1] === 5 ? 2 : values[i + 1] === 2 ? 4 : 0;
      }
    }
  }
}
