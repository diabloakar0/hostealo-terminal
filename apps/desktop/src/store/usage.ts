import { create } from "zustand";

import type { HostUse, Usage } from "../lib/hostSort";

/**
 * When and how often this device connected to each host, for sorting the list by use and for
 * the usual servers above it. Kept on this device and not synced: what one uses on the laptop
 * is not what one uses on the phone.
 */
interface UsageStore {
  byHost: Usage;
  record: (hostId: string) => void;
}

const STORAGE_KEY = "hostealo-terminal:host-usage";

function load(): Usage {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Usage;
  } catch {
    return {};
  }
}

export const useUsage = create<UsageStore>((set, get) => ({
  byHost: load(),
  record: (hostId) => {
    const previous: HostUse | undefined = get().byHost[hostId];
    const byHost = { ...get().byHost, [hostId]: { last: Date.now(), count: (previous?.count ?? 0) + 1 } };
    set({ byHost });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(byHost));
    } catch {
      // Storage full or blocked: the order just does not learn this time.
    }
  },
}));
