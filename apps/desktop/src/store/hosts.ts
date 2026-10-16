import { create } from "zustand";

import {
  foldersCreate,
  foldersDelete,
  foldersRename,
  hostsDelete,
  hostsList,
  hostsSave,
  hostsSetOs,
  snippetsDelete,
  snippetsSave,
  type Host,
  type HostOs,
  type HostsData,
  type SecretChange,
  type Snippet,
} from "../lib/ipc";

interface HostsStore {
  hosts: Host[];
  folders: string[];
  /** Quick commands, sorted by name. */
  snippets: Snippet[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (host: Host, password: SecretChange, passphrase: SecretChange) => Promise<Host>;
  remove: (id: string) => Promise<void>;
  /** Moves a host to another folder (`null` = top level), keeping its secrets. */
  move: (host: Host, folder: string | null) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  renameFolder: (from: string, to: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  /** Records the operating system detected on a connection. */
  setOs: (id: string, os: HostOs) => Promise<void>;
  saveSnippet: (snippet: Snippet) => Promise<void>;
  removeSnippet: (id: string) => Promise<void>;
}

const byName = (a: Host, b: Host) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
const KEEP: SecretChange = { action: "keep" };
const sortSnippets = (snippets: Snippet[]) =>
  [...snippets].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));

export const useHosts = create<HostsStore>((set, get) => {
  const apply = (data: HostsData) =>
    set({ hosts: [...data.hosts].sort(byName), folders: data.folders, snippets: sortSnippets(data.snippets ?? []), error: null });

  return {
    hosts: [],
    folders: [],
    snippets: [],
    loaded: false,
    error: null,

    load: async () => {
      try {
        apply(await hostsList());
      } catch (error) {
        set({ error: String(error) });
      } finally {
        set({ loaded: true });
      }
    },

    save: async (host, password, passphrase) => {
      const saved = await hostsSave(host, password, passphrase);
      // Saving can also create the host's folder, so reload the whole list.
      await get().load();
      return saved;
    },

    setOs: async (id, os) => {
      const host = get().hosts.find((h) => h.id === id);
      if (!host || (host.os?.id === os.id && host.os.name === os.name)) return;
      set({ hosts: get().hosts.map((h) => (h.id === id ? { ...h, os } : h)) });
      await hostsSetOs(id, os).catch(() => {});
    },

    remove: async (id) => {
      await hostsDelete(id);
      set((s) => ({ hosts: s.hosts.filter((h) => h.id !== id) }));
    },

    move: async (host, folder) => {
      if ((host.folder ?? null) === folder) return;
      await get().save({ ...host, folder }, KEEP, KEEP);
    },

    createFolder: async (path) => apply(await foldersCreate(path)),
    renameFolder: async (from, to) => apply(await foldersRename(from, to)),
    deleteFolder: async (path) => apply(await foldersDelete(path)),

    saveSnippet: async (snippet) => set({ snippets: sortSnippets(await snippetsSave(snippet)) }),
    removeSnippet: async (id) => set({ snippets: sortSnippets(await snippetsDelete(id)) }),
  };
});

export function hostById(id: string | null): Host | undefined {
  return id ? useHosts.getState().hosts.find((h) => h.id === id) : undefined;
}
