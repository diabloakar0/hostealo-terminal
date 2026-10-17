import { create } from "zustand";

export type ThemePreference = "system" | "dark" | "light";
export type LanguagePreference = "system" | "en" | "es";

interface Settings {
  theme: ThemePreference;
  language: LanguagePreference;
  fontSize: number;
  /** Highlight IPs, errors, dates... in plain terminal output. */
  highlightOutput: boolean;
  /** The terminal's screen reader mode (VoiceOver, NVDA...): output is read as it arrives. */
  screenReader: boolean;
  /** Face ID / Touch ID (or the device password) to open the app and to come back to it. */
  appLock: boolean;
  /** Look for a new version on start and every few hours (desktop; lib/updates.ts). */
  checkUpdates: boolean;
  /** Folder paths collapsed in the sidebar. */
  collapsedFolders: string[];
  /** The file browser shows this computer's files next to the server's. */
  filesShowLocal: boolean;
  /** Minutes between automatic syncs with the Hostealo account (0: only by hand and on start). */
  hostealoSyncMinutes: number;
  /** Alerts about the servers with an open session. */
  alertsEnabled: boolean;
  /** Also as system notifications when the app is in the background. */
  alertsNotify: boolean;
  /** Percentages that raise an alert. */
  alertDisk: number;
  alertMemory: number;
  alertCpu: number;
}

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void;
}

const STORAGE_KEY = "hostealo-terminal:settings";
const DEFAULTS: Settings = {
  theme: "system",
  language: "system",
  fontSize: 13,
  highlightOutput: true,
  screenReader: false,
  appLock: false,
  checkUpdates: true,
  collapsedFolders: [],
  filesShowLocal: true,
  hostealoSyncMinutes: 15,
  alertsEnabled: true,
  alertsNotify: true,
  alertDisk: 90,
  alertMemory: 90,
  alertCpu: 90,
};

// Plain UI preferences only. Hosts and credentials will live in the Rust-side vault, never here.
function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch);
    const { update: _update, ...settings } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage unavailable: settings still apply for this session.
    }
  },
}));
