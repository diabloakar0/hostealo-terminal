import { create } from "zustand";

/** Windows that several places can open (the sidebar, the search palette...). */
interface UiStore {
  importOpen: boolean;
  syncOpen: boolean;
  paletteOpen: boolean;
  setImportOpen: (open: boolean) => void;
  setSyncOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
}

export const useUi = create<UiStore>((set) => ({
  importOpen: false,
  syncOpen: false,
  paletteOpen: false,
  setImportOpen: (importOpen) => set({ importOpen }),
  setSyncOpen: (syncOpen) => set({ syncOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));
