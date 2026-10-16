import type { ExecOutput } from "./ipc";

/**
 * Live terminals by tab id, so other parts of the UI (the AI assistant) can read what a terminal
 * shows and type into it. Only the user's clicks lead to typing: nothing here runs on its own.
 */
export interface TerminalHandle {
  /** The last `lines` lines of output (scrollback included), as plain text. */
  recentOutput: (lines: number) => string;
  /** Types `text` at the prompt without pressing Enter. */
  insert: (text: string) => void;
  /** Types `text` and presses Enter. */
  run: (text: string) => void;
  focus: () => void;
  /** Runs a command outside the shell and returns its output (agent mode, after approval). */
  exec: (command: string, timeoutSecs: number) => Promise<ExecOutput>;
}

const terminals = new Map<string, TerminalHandle>();

export function registerTerminal(tabId: string, handle: TerminalHandle): () => void {
  terminals.set(tabId, handle);
  return () => {
    if (terminals.get(tabId) === handle) terminals.delete(tabId);
  };
}

export const getTerminal = (tabId: string | null | undefined): TerminalHandle | undefined =>
  tabId ? terminals.get(tabId) : undefined;
