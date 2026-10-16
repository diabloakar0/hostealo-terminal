import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

import i18n from "../i18n";
import { useAlerts, type Alert } from "../store/alerts";
import { LOCAL_MONITOR, useMonitors } from "../store/monitor";
import { useSettings } from "../store/settings";
import { useTabs, type Tab } from "../store/tabs";
import { hostById } from "../store/hosts";

/** The alert as one line ("Disk / at 93 %"), in the app's language. */
export function alertText(alert: Alert): string {
  return i18n.t(`alerts.kind.${alert.kind}`, { value: alert.value, mount: alert.detail, error: alert.detail });
}

/** A system notification, only when the user is not looking at the app (they see the toast). */
async function notify(alert: Alert) {
  if (!useSettings.getState().alertsNotify || document.hasFocus()) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: alert.hostName, body: alertText(alert) });
  } catch {
    // Notifications unavailable: the alert is still in the app.
  }
}

/**
 * Watches the open SSH sessions: their monitor snapshots go through the alert rules, and a session
 * that fails raises "connection lost". Returns the function that stops watching.
 */
export function startAlertWatch(): () => void {
  const sshTabs = () => useTabs.getState().tabs.filter((tab) => tab.kind === "ssh" && tab.hostId);

  const offMonitors = useMonitors.subscribe((state, previous) => {
    const settings = useSettings.getState();
    if (!settings.alertsEnabled) return;
    const thresholds = { disk: settings.alertDisk, memory: settings.alertMemory, cpu: settings.alertCpu };
    for (const [key, entry] of Object.entries(state.entries)) {
      if (key === LOCAL_MONITOR || entry === previous.entries[key] || !entry.snapshot) continue;
      const tab = sshTabs().find((t) => t.id === key);
      const host = hostById(tab?.hostId ?? null);
      if (!tab || !host) continue;
      // A host open in several tabs is watched through one of them.
      const watcher = sshTabs().find((t) => t.hostId === host.id && useMonitors.getState().entries[t.id]?.snapshot);
      if (watcher?.id !== tab.id) continue;
      for (const alert of useAlerts.getState().observe(host.id, host.name, entry.snapshot, thresholds)) void notify(alert);
    }
  });

  const offTabs = useTabs.subscribe((state, previous) => {
    const before = new Map(previous.tabs.map((tab) => [tab.id, tab]));
    const alerts = useAlerts.getState();
    for (const tab of state.tabs) {
      const old = before.get(tab.id);
      if (tab.kind !== "ssh" || !tab.hostId || !old || old.status === tab.status) continue;
      if (tab.status === "connected") alerts.connectionBack(tab.hostId);
      // Only a session that was working and dropped (a closed shell is the user's doing).
      if (tab.status === "failed" && old.status === "connected" && useSettings.getState().alertsEnabled) {
        const host = hostById(tab.hostId);
        if (host) void notify(alerts.connectionLost(host.id, host.name, i18n.t("alerts.lostDetail")));
      }
    }
    // Hosts with no open session any more stop being watched.
    const open = new Set(state.tabs.filter((tab: Tab) => tab.kind === "ssh").map((tab) => tab.hostId));
    for (const tab of previous.tabs) if (tab.kind === "ssh" && tab.hostId && !open.has(tab.hostId)) alerts.forget(tab.hostId);
  });

  return () => {
    offMonitors();
    offTabs();
  };
}
