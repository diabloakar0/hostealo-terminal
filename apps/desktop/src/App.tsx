import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, SquareTerminal } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { AiPanel } from "./components/AiPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HostDialog } from "./components/HostDialog";
import { HostealoDialog } from "./components/HostealoDialog";
import { KeysView } from "./components/KeysView";
import { KnownHostsView } from "./components/KnownHostsView";
import { AlertToasts } from "./components/AlertToasts";
import { StatusView } from "./components/StatusView";
import { DockerView } from "./components/DockerView";
import { VmView } from "./components/VmView";
import { PromptDialog } from "./components/PromptDialog";
import { useQuickCommands } from "./components/QuickCommands";
import { CommandPalette } from "./components/CommandPalette";
import { useUi } from "./store/ui";
import { useCompact, usePhoneLandscape } from "./hooks/useCompact";
import { ResourceMonitor } from "./components/ResourceBar";
import { RdpView } from "./components/RdpView";
import { SettingsDialog } from "./components/SettingsDialog";
import { FilesView } from "./components/FilesView";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalView } from "./components/TerminalView";
import { Button } from "./components/ui/Button";
import { useHostAccent } from "./hooks/useHostColor";
import { useApplyPreferences } from "./hooks/usePreferences";
import { startAlertWatch } from "./lib/alertWatch";
import { hasLocalShell, isIOS, isMac } from "./lib/format";
import { TouchKeys } from "./components/TouchKeys";
import type { Host } from "./lib/ipc";
import { matchShortcut } from "./lib/shortcuts";
import { useAi } from "./store/ai";
import { useHostealo } from "./store/hostealo";
import { useHosts } from "./store/hosts";
import { useSettings } from "./store/settings";
import { LOCAL_MONITOR, startLocalMonitor, useMonitors } from "./store/monitor";
import { hostTabKind, isEnded, isTerminalTab, useTabs, type Tab } from "./store/tabs";

type HostDialogState = { mode: "new"; folder: string | null } | { mode: "edit"; host: Host } | null;

export default function App() {
  useApplyPreferences();
  const { t } = useTranslation();
  const { tabs, activeId, openLocal, openSsh, openSftp, openFtp, openRdp, openPage } = useTabs();
  const hosts = useHosts((s) => s.hosts);
  const removeHost = useHosts((s) => s.remove);
  const monitors = useMonitors((s) => s.entries);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [monitorExpanded, setMonitorExpanded] = useState(false);
  const [hostDialog, setHostDialog] = useState<HostDialogState>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const assistantOpen = useAi((s) => s.open);
  const compact = useCompact();
  const phoneLandscape = usePhoneLandscape();
  // Remote desktop on a phone on its side: nothing but the desktop, the tab bar on demand.
  const [chromeShown, setChromeShown] = useState(false);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => (hasLocalShell ? startLocalMonitor() : undefined), []);
  useEffect(() => startAlertWatch(), []);
  useEffect(() => {
    // The hosts first, then the Hostealo account brings its servers up to date.
    void useHosts
      .getState()
      .load()
      .then(() => useHostealo.getState().init());
  }, []);
  const hostealoOpen = useHostealo((s) => s.dialogOpen);

  // Keeps the Hostealo servers up to date: every few minutes, and on coming back to the app (a
  // laptop waking up) when the last sync is older than that.
  const hostealoConnected = useHostealo((s) => Boolean(s.account));
  const syncMinutes = useSettings((s) => s.hostealoSyncMinutes);
  useEffect(() => {
    if (!hostealoConnected || syncMinutes <= 0) return;
    const every = syncMinutes * 60_000;
    const syncIfStale = () => {
      const { lastSyncAt, sync } = useHostealo.getState();
      if (!lastSyncAt || Date.now() - lastSyncAt >= every - 5_000) void sync();
    };
    const timer = setInterval(syncIfStale, every);
    window.addEventListener("focus", syncIfStale);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", syncIfStale);
    };
  }, [hostealoConnected, syncMinutes]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const shortcut = matchShortcut(e);
      if (!shortcut) return;
      e.preventDefault();
      const tabs = useTabs.getState();
      switch (shortcut.action) {
        case "newTab":
          return hasLocalShell ? tabs.openLocal() : useUi.getState().setPaletteOpen(true);
        case "closeTab":
          return tabs.activeId && tabs.close(tabs.activeId);
        case "selectTab":
          return tabs.activateIndex(shortcut.index);
        case "settings":
          return setSettingsOpen(true);
        case "assistant":
          return useAi.getState().toggle();
        case "palette":
          return useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen);
        case "quickCommands": {
          const active = tabs.tabs.find((tab) => tab.id === tabs.activeId);
          return active && isTerminalTab(active) && useQuickCommands.getState().toggle();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Back to the host's most recent session (reconnecting it if it ended), or a new one. */
  const openHost = (host: Host, fresh = false) => {
    const kind = hostTabKind(host.protocol);
    const existing = useTabs
      .getState()
      .tabs.filter((tab) => tab.kind === kind && tab.hostId === host.id)
      .sort((a, b) => b.usedAt - a.usedAt)[0];
    if (existing && !fresh) {
      if (isEnded(existing)) useTabs.getState().reopen(existing.id);
      else useTabs.getState().activate(existing.id);
      return;
    }
    if (host.protocol === "ssh") openSsh(host.id);
    else if (host.protocol === "rdp") openRdp(host.id);
    else openFtp(host.id);
  };

  const activeTab = tabs.find((tab) => tab.id === activeId);
  const immersive = phoneLandscape && activeTab?.kind === "rdp";
  const edge = immersive ? "all" : compact && activeTab?.kind === "rdp" ? "bottom" : null;
  useEffect(() => {
    if (edge) document.documentElement.dataset.edge = edge;
    else delete document.documentElement.dataset.edge;
  }, [edge]);
  const activeHost = activeTab?.kind === "ssh" ? hosts.find((h) => h.id === activeTab.hostId) : undefined;
  const activeAccent = useHostAccent(activeHost?.id ?? null);

  // On a phone the sidebar is a drawer: whatever is picked in it closes it.
  const fromSidebar =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      if (compact) setSidebarOpen(false);
      action(...args);
    };
  const sidebar = (
    <Sidebar
      onNewLocal={fromSidebar(openLocal)}
      onConnect={fromSidebar(openHost)}
      onOpenSftp={fromSidebar((host: Host) => openSftp(host.id))}
      onOpenPage={fromSidebar(openPage)}
      onNewHost={fromSidebar((folder: string | null) => setHostDialog({ mode: "new", folder }))}
      onEditHost={fromSidebar((host: Host) => setHostDialog({ mode: "edit", host }))}
      onDeleteHost={setDeleting}
      onOpenSettings={fromSidebar(() => setSettingsOpen(true))}
    />
  );

  return (
    <div className="flex h-full text-fg">
      {!compact && sidebar}
      {compact && sidebarOpen && (
        <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
          <div className="flex h-full w-[85vw] max-w-80 flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-xl">{sidebar}</div>
          <button type="button" className="flex-1 bg-black/40" aria-label={t("common.close")} onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      <main className="v2-shell-main relative flex min-w-0 flex-1 flex-col overflow-hidden compact:rounded-none! compact:border-0! roomy:my-2 roomy:mr-2">
        {!immersive ? (
          <TabBar />
        ) : (
          <>
            {/* Over the desktop, so showing it does not change the remote resolution. */}
            {chromeShown && (
              <div className="absolute inset-x-0 top-0 z-30 bg-card shadow-md">
                <TabBar />
              </div>
            )}
            <button
              type="button"
              onClick={() => setChromeShown((shown) => !shown)}
              aria-label={t(chromeShown ? "rdp.hideBar" : "rdp.showBar")}
              aria-expanded={chromeShown}
              className={cn(
                "absolute left-1/2 z-40 grid h-6 w-14 -translate-x-1/2 place-items-center rounded-b-lg bg-black/45 text-white/90 backdrop-blur transition-[top]",
                chromeShown ? "top-11" : "top-0",
              )}
            >
              {chromeShown ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
          </>
        )}

        <div className="relative min-h-0 flex-1">
          {tabs.map((tab) => (
            <TabContent key={tab.id} tab={tab} active={tab.id === activeId} />
          ))}
          {tabs.length === 0 && (
            <div className="grid h-full place-items-center">
              <div className="text-center">
                <SquareTerminal className="mx-auto mb-3 size-8 text-fg-muted" />
                {hasLocalShell ? (
                  <Button variant="primary" onClick={openLocal}>
                    {t("tabs.new")}
                    <kbd className="text-xs opacity-70">{isMac ? "⌘T" : "Ctrl+Shift+T"}</kbd>
                  </Button>
                ) : (
                  <>
                    <Button variant="primary" onClick={() => useUi.getState().setPaletteOpen(true)}>
                      {t("tabs.openServer")}
                    </Button>
                    <p className="mt-2 text-sm text-fg-muted">{t("tabs.openServerHint")}</p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {isIOS && activeTab && isTerminalTab(activeTab) && <TouchKeys tabId={activeTab.id} />}
        {activeTab && isTerminalTab(activeTab) && (
          <ResourceMonitor
            entry={monitors[activeTab.kind === "ssh" ? activeTab.id : LOCAL_MONITOR]}
            kind={activeTab.kind === "ssh" ? "ssh" : "local"}
            status={activeTab.status}
            label={activeTab.kind === "ssh" ? (activeHost?.name ?? "SSH") : t("monitor.local")}
            accent={activeAccent?.hex}
            expanded={monitorExpanded}
            onToggle={() => setMonitorExpanded((v) => !v)}
          />
        )}
      </main>

      {assistantOpen && <AiPanel />}

      {settingsOpen && <SettingsDialog onClose={closeSettings} />}
      {hostealoOpen && <HostealoDialog onClose={() => useHostealo.getState().setDialogOpen(false)} />}

      {hostDialog && (
        <HostDialog
          host={hostDialog.mode === "edit" ? hostDialog.host : undefined}
          defaultFolder={hostDialog.mode === "new" ? hostDialog.folder : undefined}
          onClose={() => setHostDialog(null)}
          onSaved={(host, connect) => {
            setHostDialog(null);
            if (connect) openHost(host);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t("host.deleteTitle")}
          confirmLabel={t("sidebar.delete")}
          onConfirm={() => removeHost(deleting.id)}
          onClose={() => setDeleting(null)}
        >
          <Trans i18nKey="host.deleteBody" values={{ name: deleting.name }} components={{ b: <strong className="text-fg" /> }} />
        </ConfirmDialog>
      )}

      <PromptDialog />
      <AlertToasts />
      <CommandPalette onOpenHost={openHost} onNewHost={() => setHostDialog({ mode: "new", folder: null })} onOpenSettings={() => setSettingsOpen(true)} />
    </div>
  );
}

function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  if (isTerminalTab(tab)) return <TerminalView tab={tab} active={active} />;
  // Pages stay mounted while hidden, so an SFTP session and its transfers survive tab switches.
  return (
    <div className={active ? "absolute inset-0" : "hidden"}>
      {(tab.kind === "sftp" || tab.kind === "ftp") && <FilesView tab={tab} active={active} />}
      {tab.kind === "rdp" && <RdpView tab={tab} active={active} />}
      {tab.kind === "docker" && <DockerView tab={tab} active={active} />}
      {tab.kind === "vms" && <VmView tab={tab} active={active} />}
      {tab.kind === "keys" && <KeysView />}
      {tab.kind === "knownHosts" && <KnownHostsView />}
      {tab.kind === "status" && <StatusView />}
    </div>
  );
}
