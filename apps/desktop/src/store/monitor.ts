import { create } from "zustand";

import { monitorLocal, type ResourceSnapshot } from "../lib/ipc";

export const POLL_INTERVAL_MS = 2000;
/** Two minutes of history at the poll interval. */
const HISTORY_LENGTH = 60;
/** All local tabs show the same machine, so they share one entry. */
export const LOCAL_MONITOR = "local";

export interface MonitorHistory {
  cpu: number[];
  rx: number[];
  tx: number[];
}

export interface MonitorEntry {
  snapshot: ResourceSnapshot | null;
  history: MonitorHistory;
  /** The remote host cannot be monitored (not Linux). */
  unsupported: boolean;
}

interface MonitorStore {
  /** Keyed by `LOCAL_MONITOR` or by the SSH tab id. */
  entries: Record<string, MonitorEntry>;
  push: (key: string, snapshot: ResourceSnapshot) => void;
  setUnsupported: (key: string) => void;
  remove: (key: string) => void;
}

const EMPTY_HISTORY: MonitorHistory = { cpu: [], rx: [], tx: [] };
const append = (values: number[], value: number) => [...values, value].slice(-HISTORY_LENGTH);

export const useMonitors = create<MonitorStore>((set) => ({
  entries: {},
  push: (key, snapshot) =>
    set((s) => {
      const history = s.entries[key]?.history ?? EMPTY_HISTORY;
      return {
        entries: {
          ...s.entries,
          [key]: {
            snapshot,
            unsupported: false,
            history: {
              cpu: append(history.cpu, snapshot.cpuPercent),
              rx: append(history.rx, snapshot.netRxBps),
              tx: append(history.tx, snapshot.netTxBps),
            },
          },
        },
      };
    }),
  setUnsupported: (key) =>
    set((s) => ({ entries: { ...s.entries, [key]: { snapshot: null, history: EMPTY_HISTORY, unsupported: true } } })),
  remove: (key) =>
    set((s) => {
      const { [key]: _removed, ...entries } = s.entries;
      return { entries };
    }),
}));

export function startLocalMonitor(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    try {
      const snapshot = await monitorLocal();
      if (!stopped) useMonitors.getState().push(LOCAL_MONITOR, snapshot);
    } catch (error) {
      console.error("monitor_local failed", error);
    }
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  void tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
