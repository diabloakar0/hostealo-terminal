import type { Host } from "./ipc";

/**
 * The orders of the server list (inside each folder; folders stay alphabetical). "added" is the
 * order the servers were created in, the list as it was before there was a choice.
 */
export type HostSort = "added" | "addedDesc" | "name" | "nameDesc" | "os" | "recent" | "frequent";

export const HOST_SORTS: HostSort[] = ["added", "addedDesc", "name", "nameDesc", "os", "recent", "frequent"];

/** When and how often this device connected to a host (store/usage.ts). */
export interface HostUse {
  last: number;
  count: number;
}

export type Usage = Record<string, HostUse>;

const byName = (a: Host, b: Host) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** The system's name for sorting ("Ubuntu", "Windows"...); none sorts last. */
const osName = (host: Host) => host.os?.name ?? (host.protocol === "rdp" ? "Windows" : null);

/** Most connections first, the latest one breaking ties. */
const byUse = (usage: Usage) => (a: Host, b: Host) => {
  const ua = usage[a.id];
  const ub = usage[b.id];
  return (ub?.count ?? 0) - (ua?.count ?? 0) || (ub?.last ?? 0) - (ua?.last ?? 0);
};

/**
 * Sorts `hosts` (in the order they were created) for the list. Servers never connected to go
 * after the others when sorting by use, by name among themselves.
 */
export function sortHosts(hosts: Host[], sort: HostSort, usage: Usage): Host[] {
  switch (sort) {
    case "added":
      return hosts;
    case "addedDesc":
      return [...hosts].reverse();
    case "name":
      return [...hosts].sort(byName);
    case "nameDesc":
      return [...hosts].sort((a, b) => byName(b, a));
    case "os":
      return [...hosts].sort((a, b) => {
        const [oa, ob] = [osName(a), osName(b)];
        if (oa !== ob) return oa === null ? 1 : ob === null ? -1 : oa.localeCompare(ob, undefined, { sensitivity: "base" });
        return byName(a, b);
      });
    case "recent":
      return [...hosts].sort((a, b) => (usage[b.id]?.last ?? 0) - (usage[a.id]?.last ?? 0) || byName(a, b));
    case "frequent":
      return [...hosts].sort((a, b) => byUse(usage)(a, b) || byName(a, b));
  }
}

/** Below this many servers, a list of the usual ones would only repeat the list. */
export const FREQUENT_MIN_HOSTS = 6;
export const FREQUENT_COUNT = 4;

/** The servers connected to most often (at least twice), for quick access above the list. */
export function frequentHosts(hosts: Host[], usage: Usage): Host[] {
  if (hosts.length < FREQUENT_MIN_HOSTS) return [];
  return hosts
    .filter((h) => (usage[h.id]?.count ?? 0) >= 2)
    .sort(byUse(usage))
    .slice(0, FREQUENT_COUNT);
}
