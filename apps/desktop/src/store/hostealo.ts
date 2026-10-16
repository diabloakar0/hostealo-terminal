import { create } from "zustand";

import { hostealoAccount, hostealoSync, type HostealoAccount, type HostealoSyncResult } from "../lib/ipc";
import { useHosts } from "./hosts";

interface HostealoStore {
  /** `undefined` while unknown, `null` when not connected. */
  account: HostealoAccount | null | undefined;
  dialogOpen: boolean;
  syncing: boolean;
  lastSync: HostealoSyncResult | null;
  /** When the last sync finished well (ms since the epoch). */
  lastSyncAt: number | null;
  error: string | null;
  setDialogOpen: (open: boolean) => void;
  setAccount: (account: HostealoAccount | null) => void;
  /** Looks up the account and, when connected, brings the server list up to date. */
  init: () => Promise<void>;
  sync: () => Promise<void>;
}

export const useHostealo = create<HostealoStore>((set, get) => ({
  account: undefined,
  dialogOpen: false,
  syncing: false,
  lastSync: null,
  lastSyncAt: null,
  error: null,
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
  setAccount: (account) => set({ account, lastSync: null, lastSyncAt: null, error: null }),
  init: async () => {
    try {
      const account = await hostealoAccount();
      set({ account });
      if (account) await get().sync();
    } catch (e) {
      // Offline or a revoked key: the app works without the account.
      set({ account: null, error: String(e) });
    }
  },
  sync: async () => {
    if (get().syncing) return;
    set({ syncing: true, error: null });
    try {
      const result = await hostealoSync();
      set({ lastSync: result, lastSyncAt: Date.now() });
      await useHosts.getState().load();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ syncing: false });
    }
  },
}));
