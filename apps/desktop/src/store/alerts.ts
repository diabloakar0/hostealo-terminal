import { create } from "zustand";

import type { ResourceSnapshot } from "../lib/ipc";

/** What went wrong on a connected server. */
export type AlertKind = "disk" | "memory" | "cpu" | "disconnected";

export interface Alert {
  id: string;
  hostId: string;
  hostName: string;
  kind: AlertKind;
  /** The disk's mount point, or the error that closed the connection. */
  detail: string;
  /** The percentage that crossed the threshold. */
  value: number | null;
  at: number;
  /** Still happening (it clears on its own when it stops). */
  active: boolean;
}

export interface Thresholds {
  disk: number;
  memory: number;
  cpu: number;
}

/** How long a resource must stay over its threshold before it counts (spikes are normal). */
export const SUSTAIN_MS: Record<"disk" | "memory" | "cpu", number> = { disk: 0, memory: 60_000, cpu: 120_000 };
/** It clears once it drops this many points below the threshold, so it does not flap. */
export const HYSTERESIS = 5;
const MAX_ALERTS = 50;

/** One rule on one server: since when it is over the threshold, and whether it fired. */
export interface Condition {
  since: number | null;
  firing: boolean;
}

export interface Reading {
  key: string;
  kind: "disk" | "memory" | "cpu";
  detail: string;
  value: number;
}

/** The values the rules look at, from a monitor snapshot. */
export function readings(snapshot: ResourceSnapshot): Reading[] {
  const out: Reading[] = [];
  if (snapshot.memTotal > 0) out.push({ key: "memory", kind: "memory", detail: "", value: (snapshot.memUsed / snapshot.memTotal) * 100 });
  out.push({ key: "cpu", kind: "cpu", detail: "", value: snapshot.cpuPercent });
  for (const disk of snapshot.disks) {
    if (disk.total > 0) out.push({ key: `disk:${disk.mount}`, kind: "disk", detail: disk.mount, value: (disk.used / disk.total) * 100 });
  }
  return out;
}

/**
 * Moves one rule forward with a new reading: `fire` when it has been over the threshold long
 * enough, `clear` when it has dropped clearly below.
 */
export function step(
  condition: Condition | undefined,
  reading: Reading,
  threshold: number,
  now: number,
): { condition: Condition; event: "fire" | "clear" | null } {
  const current = condition ?? { since: null, firing: false };
  if (current.firing) {
    if (reading.value < threshold - HYSTERESIS) return { condition: { since: null, firing: false }, event: "clear" };
    return { condition: current, event: null };
  }
  if (reading.value < threshold) return { condition: { since: null, firing: false }, event: null };
  const since = current.since ?? now;
  if (now - since >= SUSTAIN_MS[reading.kind]) return { condition: { since, firing: true }, event: "fire" };
  return { condition: { since, firing: false }, event: null };
}

interface AlertsStore {
  alerts: Alert[];
  /** By `hostId|rule`. */
  conditions: Record<string, Condition>;
  /** Alerts shown as a toast, until dismissed or timed out. */
  toasts: string[];
  /** Feeds a server's latest snapshot; returns the alerts it fired. */
  observe: (hostId: string, hostName: string, snapshot: ResourceSnapshot, thresholds: Thresholds, now?: number) => Alert[];
  connectionLost: (hostId: string, hostName: string, error: string) => Alert;
  connectionBack: (hostId: string) => void;
  /** The server is no longer open anywhere: what it had going stops being "active". */
  forget: (hostId: string) => void;
  dismissToast: (id: string) => void;
  clear: () => void;
}

const newAlert = (fields: Omit<Alert, "id" | "at" | "active">, at: number): Alert => ({ ...fields, id: crypto.randomUUID(), at, active: true });

export const useAlerts = create<AlertsStore>((set, get) => {
  /** Ends the active alert of a rule (it is kept in the list, as resolved). */
  const resolve = (alerts: Alert[], hostId: string, kind: AlertKind, detail?: string) =>
    alerts.map((a) => (a.active && a.hostId === hostId && a.kind === kind && (detail === undefined || a.detail === detail) ? { ...a, active: false } : a));

  const add = (alert: Alert) =>
    set((s) => ({ alerts: [alert, ...s.alerts].slice(0, MAX_ALERTS), toasts: [...s.toasts, alert.id] }));

  return {
    alerts: [],
    conditions: {},
    toasts: [],

    observe: (hostId, hostName, snapshot, thresholds, now = Date.now()) => {
      const conditions = { ...get().conditions };
      let alerts = get().alerts;
      const fired: Alert[] = [];
      for (const reading of readings(snapshot)) {
        const key = `${hostId}|${reading.key}`;
        const { condition, event } = step(conditions[key], reading, thresholds[reading.kind], now);
        conditions[key] = condition;
        if (event === "fire") fired.push(newAlert({ hostId, hostName, kind: reading.kind, detail: reading.detail, value: Math.round(reading.value) }, now));
        if (event === "clear") alerts = resolve(alerts, hostId, reading.kind, reading.detail);
      }
      set({ conditions, alerts });
      fired.forEach(add);
      return fired;
    },

    connectionLost: (hostId, hostName, error) => {
      const alert = newAlert({ hostId, hostName, kind: "disconnected", detail: error, value: null }, Date.now());
      set((s) => ({ alerts: resolve(s.alerts, hostId, "disconnected") }));
      add(alert);
      return alert;
    },

    connectionBack: (hostId) => set((s) => ({ alerts: resolve(s.alerts, hostId, "disconnected") })),

    forget: (hostId) =>
      set((s) => ({
        alerts: s.alerts.map((a) => (a.hostId === hostId && a.kind !== "disconnected" ? { ...a, active: false } : a)),
        conditions: Object.fromEntries(Object.entries(s.conditions).filter(([key]) => !key.startsWith(`${hostId}|`))),
      })),

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t !== id) })),
    clear: () => set((s) => ({ alerts: s.alerts.filter((a) => a.active), toasts: [] })),
  };
});
