import { create } from "zustand";

import { useSettings } from "../store/settings";
import { isIOS } from "./format";

/**
 * Updates of the desktop app, from GitHub Releases (`latest.json`, signed with the project's
 * updater key, which the app checks before installing). The App Store updates the iOS app.
 */
export const canUpdate = !isIOS;

/** The first check waits for the app to settle; then one every few hours while it is open. */
const FIRST_CHECK_MS = 8_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type Update = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; done: number; total: number | null }
  | { kind: "restart"; version: string }
  | { kind: "error"; message: string };

interface UpdateStore {
  status: UpdateStatus;
  /** The update found, kept to install it. */
  update: Update;
  /** The user closed the notice of this version: not shown again until the next one. */
  dismissed: string | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdates = create<UpdateStore>((set, get) => ({
  status: { kind: "idle" },
  update: null,
  dismissed: null,

  check: async () => {
    if (!canUpdate) return;
    const busy = get().status.kind;
    if (busy === "checking" || busy === "downloading" || busy === "restart") return;
    set({ status: { kind: "checking" } });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      set(
        update
          ? { update, status: { kind: "available", version: update.version, notes: update.body?.trim() || null } }
          : { update: null, status: { kind: "upToDate" } },
      );
    } catch (e) {
      // Offline, or GitHub unreachable: nothing to install (UpdateNotice stays hidden).
      set({ update: null, status: { kind: "error", message: String(e) } });
    }
  },

  install: async () => {
    const { update } = get();
    if (!update) return;
    const version = update.version;
    let done = 0;
    let total: number | null = null;
    set({ status: { kind: "downloading", version, done, total } });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        else if (event.event === "Progress") done += event.data.chunkLength;
        set({ status: { kind: "downloading", version, done, total } });
      });
      set({ status: { kind: "restart", version } });
      // Windows closes the app itself to run the installer; macOS and Linux restart into it.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ status: { kind: "error", message: String(e) } });
    }
  },

  dismiss: () => {
    const status = get().status;
    if (status.kind === "available") set({ dismissed: status.version });
  },
}));

/** Checks on start and then every few hours, while the setting is on. Returns the stop. */
export function startUpdateWatch(): () => void {
  if (!canUpdate) return () => {};
  const run = () => {
    if (useSettings.getState().checkUpdates) void useUpdates.getState().check();
  };
  const first = window.setTimeout(run, FIRST_CHECK_MS);
  const every = window.setInterval(run, CHECK_EVERY_MS);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(every);
  };
}
