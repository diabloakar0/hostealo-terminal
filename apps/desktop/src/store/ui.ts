import { create } from "zustand";

/** Windows that several places can open (the sidebar, the search palette...). */
interface UiStore {
  importOpen: boolean;
  syncOpen: boolean;
  paletteOpen: boolean;
  /** The sidebar as a drawer, on phone-sized screens. */
  sidebarOpen: boolean;
  /** A pairing link the app was opened with (the sync QR code scanned with the camera). */
  syncLink: string | null;
  setImportOpen: (open: boolean) => void;
  setSyncOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  /** Opens device sync connecting to `link`, or forgets it (`null`). */
  setSyncLink: (link: string | null) => void;
}

export const useUi = create<UiStore>((set) => ({
  importOpen: false,
  syncOpen: false,
  paletteOpen: false,
  sidebarOpen: false,
  syncLink: null,
  setImportOpen: (importOpen) => set({ importOpen }),
  setSyncOpen: (syncOpen) => set({ syncOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSyncLink: (syncLink) => set(syncLink ? { syncLink, syncOpen: true } : { syncLink }),
}));
