import { create } from "zustand";

/**
 * The file open in the editor of each file browser tab, so the AI assistant can read it and
 * apply what it suggests. Applying only changes the editor: nothing is saved until the user does.
 */
export interface EditorHandle {
  path: string;
  /** The syntax in use (the picker's id). */
  language: () => string;
  text: () => string;
  /** The selected lines, if any text is selected. */
  selection: () => { text: string; fromLine: number; toLine: number } | null;
  /** Replaces the selection, or inserts at the cursor when nothing is selected. */
  insert: (text: string) => void;
  replaceAll: (text: string) => void;
  focus: () => void;
}

export const useEditors = create<{ byTab: Record<string, EditorHandle>; set: (tabId: string, handle: EditorHandle | null) => void }>((set) => ({
  byTab: {},
  set: (tabId, handle) =>
    set((s) => {
      const byTab = { ...s.byTab };
      if (handle) byTab[tabId] = handle;
      else delete byTab[tabId];
      return { byTab };
    }),
}));

export const getEditor = (tabId: string | null | undefined): EditorHandle | undefined => (tabId ? useEditors.getState().byTab[tabId] : undefined);
