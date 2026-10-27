import { create } from "zustand";

import { hasLocalShell } from "../lib/format";
import { useUsage } from "./usage";

export type TabKind = "local" | "ssh" | "sftp" | "ftp" | "rdp" | "docker" | "vms" | "keys" | "knownHosts" | "status";
/** Tabs that show a terminal (the others are pages). */
export const isTerminalTab = (tab: Tab) => tab.kind === "local" || tab.kind === "ssh";
export type TabStatus = "connecting" | "authenticating" | "connected" | "closed" | "failed";

export interface Tab {
  id: string;
  kind: TabKind;
  /** Saved host for SSH and SFTP tabs. */
  hostId: string | null;
  /** Title set by the shell through OSC 0/2, if any. */
  title: string | null;
  status: TabStatus;
  /** When it was last the active tab (for going back to the most recent session of a host). */
  usedAt: number;
  /** Typed once the session connects (e.g. `docker exec` into a container). */
  initialInput?: string;
}

/** The tab a host opens in: its terminal, its remote desktop or its files. */
export const hostTabKind = (protocol: string): TabKind => (protocol === "ssh" ? "ssh" : protocol === "rdp" ? "rdp" : "ftp");

/** A session that ended: going back to it means connecting again. */
export const isEnded = (tab: Tab) => tab.status === "closed" || tab.status === "failed";

interface TabsStore {
  tabs: Tab[];
  activeId: string | null;
  openLocal: () => void;
  openSsh: (hostId: string, initialInput?: string) => void;
  /** The host's Docker manager (focused if already open). */
  openDocker: (hostId: string) => void;
  /** The host's virtual machines (Proxmox or KVM; focused if already open). */
  openVms: (hostId: string) => void;
  openSftp: (hostId: string) => void;
  openFtp: (hostId: string) => void;
  openRdp: (hostId: string) => void;
  /** Opens a page (keys, known hosts, status), or focuses it if it is already open. */
  openPage: (kind: "keys" | "knownHosts" | "status") => void;
  close: (id: string) => void;
  /** Starts the tab's session again in the same place (a new id remounts its view). */
  reopen: (id: string) => void;
  activate: (id: string) => void;
  activateIndex: (index: number) => void;
  setTitle: (id: string, title: string) => void;
  setStatus: (id: string, status: TabStatus) => void;
}

function newTab(kind: TabKind, hostId: string | null = null): Tab {
  const remote = kind === "ssh" || kind === "sftp" || kind === "ftp" || kind === "rdp" || kind === "docker" || kind === "vms";
  return { id: crypto.randomUUID(), kind, hostId, title: null, status: remote ? "connecting" : "connected", usedAt: Date.now() };
}

// Desktop opens on a local terminal; iOS has none, so it opens on the list of servers.
const first = hasLocalShell ? newTab("local") : null;

export const useTabs = create<TabsStore>((set, get) => {
  const add = (tab: Tab) => {
    // Every session opened on a host counts for sorting by use and for the usual servers.
    if (tab.hostId) useUsage.getState().record(tab.hostId);
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  };
  const focus = (id: string) => set((s) => ({ activeId: id, tabs: s.tabs.map((t) => (t.id === id ? { ...t, usedAt: Date.now() } : t)) }));
  const patch = (id: string, changes: Partial<Tab>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t)) }));

  return {
    tabs: first ? [first] : [],
    activeId: first?.id ?? null,

    openLocal: () => {
      if (hasLocalShell) add(newTab("local"));
    },
    openSsh: (hostId, initialInput) => add({ ...newTab("ssh", hostId), initialInput }),
    openDocker: (hostId) => {
      const existing = get().tabs.find((t) => t.kind === "docker" && t.hostId === hostId);
      if (existing) focus(existing.id);
      else add(newTab("docker", hostId));
    },
    openVms: (hostId) => {
      const existing = get().tabs.find((t) => t.kind === "vms" && t.hostId === hostId);
      if (existing) focus(existing.id);
      else add(newTab("vms", hostId));
    },
    openSftp: (hostId) => add(newTab("sftp", hostId)),
    openFtp: (hostId) => add(newTab("ftp", hostId)),
    openRdp: (hostId) => add(newTab("rdp", hostId)),
    openPage: (kind) => {
      const existing = get().tabs.find((t) => t.kind === kind);
      if (existing) focus(existing.id);
      else add(newTab(kind));
    },

    close: (id) => {
      const { tabs, activeId } = get();
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1) return;
      const remaining = tabs.filter((t) => t.id !== id);
      // Closing the active tab focuses its right neighbour, or the left one at the end.
      const nextActive =
        activeId === id ? ((remaining[index] ?? remaining[index - 1] ?? null)?.id ?? null) : activeId;
      set({ tabs: remaining, activeId: nextActive });
    },

    reopen: (id) => {
      const old = get().tabs.find((t) => t.id === id);
      if (!old) return;
      const fresh = newTab(old.kind, old.hostId);
      if (fresh.hostId) useUsage.getState().record(fresh.hostId);
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? fresh : t)), activeId: fresh.id }));
    },

    activate: (id) => focus(id),

    activateIndex: (index) => {
      const tab = get().tabs[index];
      if (tab) focus(tab.id);
    },

    setTitle: (id, title) => patch(id, { title }),
    setStatus: (id, status) => patch(id, { status }),
  };
});
