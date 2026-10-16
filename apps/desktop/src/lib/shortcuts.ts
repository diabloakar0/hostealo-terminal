import { isMac } from "./format";

export type AppShortcut =
  | { action: "newTab" }
  | { action: "closeTab" }
  | { action: "settings" }
  | { action: "assistant" }
  | { action: "quickCommands" }
  | { action: "palette" }
  | { action: "selectTab"; index: number };

/**
 * App-level shortcuts. On Windows/Linux they need Ctrl+Shift, because plain Ctrl+W, Ctrl+T etc.
 * belong to the shell (Ctrl+W deletes a word in bash).
 */
export function matchShortcut(e: KeyboardEvent): AppShortcut | null {
  const modifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.metaKey;
  if (!modifier || e.altKey) return null;

  switch (e.code) {
    case "KeyT":
      return { action: "newTab" };
    case "KeyW":
      return { action: "closeTab" };
    case "Comma":
      return { action: "settings" };
    case "KeyI":
      return { action: "assistant" };
    case "KeyP":
      return { action: "quickCommands" };
    case "KeyK":
      return { action: "palette" };
  }
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { action: "selectTab", index: Number(digit[1]) - 1 };
  return null;
}
