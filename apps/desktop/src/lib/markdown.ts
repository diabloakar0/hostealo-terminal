/** The bits of Markdown the assistant uses, parsed into blocks rendered as React elements. */
export type MarkdownBlock =
  | { type: "code"; lang: string; code: string; complete: boolean }
  | { type: "heading"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string };

/** Splits a (possibly still streaming) reply into blocks. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    if (list) blocks.push({ type: "list", ...list });
    paragraph = [];
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      let complete = false;
      for (i++; i < lines.length; i++) {
        if (lines[i].trim().startsWith(fence[1])) {
          complete = true;
          break;
        }
        code.push(lines[i]);
      }
      blocks.push({ type: "code", lang: fence[2].toLowerCase(), code: code.join("\n"), complete });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", text: heading[1] });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[3]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list && /^\s{2,}/.test(line)) {
      // A wrapped list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

export type InlinePart = { type: "text" | "code" | "bold"; text: string };

/** `code` and **bold** inside a line of text. */
export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ type: "text", text: text.slice(last, match.index) });
    parts.push(match[1] !== undefined ? { type: "code", text: match[1] } : { type: "bold", text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

/** Code blocks in these languages are commands for a shell. */
export const isShellLanguage = (lang: string) =>
  ["", "bash", "sh", "shell", "zsh", "console", "powershell", "ps1", "pwsh", "cmd", "bat", "fish"].includes(lang);
