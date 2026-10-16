import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { Activity, ChevronDown, Fingerprint, FolderOpen, KeyRound, Menu, Plus, Search, Sparkles, SquareTerminal, X } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { hasLocalShell, isMac } from "../lib/format";
import { useAi } from "../store/ai";
import { useHosts } from "../store/hosts";
import { useHostAccent } from "../hooks/useHostColor";
import { isTerminalTab, useTabs, type Tab } from "../store/tabs";
import { QuickCommandsButton } from "./QuickCommands";
import { RdpToolbar } from "./RdpToolbar";
import { useUi } from "../store/ui";
import { useCompact } from "../hooks/useCompact";
import { hostOsId, OsIcon } from "./OsIcon";
import { StatusDot } from "./StatusDot";
import { Button } from "./ui/Button";

export function TabBar() {
  const { t } = useTranslation();
  const { tabs, activeId, activate, close, openLocal, openSftp } = useTabs();
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const hosts = useHosts((s) => s.hosts);
  const assistantOpen = useAi((s) => s.open);
  const toggleAssistant = useAi((s) => s.toggle);
  const compact = useCompact();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // A sideways swipe on the bar moves to the next or previous session (phones).
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onSwipeEnd = (x: number, y: number) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || Math.abs(x - start.x) < 60 || Math.abs(y - start.y) > 40) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const next = tabs[index + (x < start.x ? 1 : -1)];
    if (next) activate(next.id);
  };

  const label = (tab: Tab) => {
    const host = hosts.find((h) => h.id === tab.hostId)?.name;
    switch (tab.kind) {
      case "ssh":
        return host ?? "SSH";
      case "sftp":
        return `${host ?? ""} · SFTP`;
      case "ftp":
        return `${host ?? ""} · ${hosts.find((h) => h.id === tab.hostId)?.protocol === "ftps" ? "FTPS" : "FTP"}`;
      case "rdp":
        return `${host ?? ""} · RDP`;
      case "docker":
        return `${host ?? ""} · Docker`;
      case "vms":
        return `${host ?? ""} · ${t("vms.short")}`;
      case "keys":
        return t("keys.title");
      case "knownHosts":
        return t("knownHosts.title");
      case "status":
        return t("status.title");
      default:
        return tab.title || t("tabs.local");
    }
  };

  return (
    <div data-tauri-drag-region className="flex h-11 touch:h-13 shrink-0 items-center gap-1 border-b border-border px-2">
      {/* Phone-sized screens: the sidebar is a drawer behind this button. */}
      <Button variant="ghost" size="icon" className="roomy:hidden" onClick={() => useUi.getState().setSidebarOpen(true)} aria-label={t("sidebar.open")}>
        <Menu className="size-4" />
      </Button>
      {compact ? (
        // Phones: the current session, and the others in a list from the bottom (like Safari).
        activeTab && (
          <button
            type="button"
            onClick={() => setSwitcherOpen(true)}
            onTouchStart={(e) => (swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
            onTouchEnd={(e) => onSwipeEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY)}
            aria-haspopup="dialog"
            aria-label={t("tabs.sessions", { count: tabs.length })}
            className="flex h-9 min-w-0 shrink cursor-pointer items-center gap-2 rounded-btn-sm border border-border bg-card px-2.5 text-[13px] text-fg shadow-sm"
          >
            <TabIcon tab={activeTab} active />
            <span className="truncate">{label(activeTab)}</span>
            {tabs.length > 1 && <span className="rounded-badge bg-muted px-1.5 text-[11px] font-medium text-fg-secondary">{tabs.length}</span>}
            <ChevronDown className="size-3.5 shrink-0 text-fg-muted" />
          </button>
        )
      ) : (
        <div role="tablist" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              label={label(tab)}
              active={tab.id === activeId}
              onActivate={() => activate(tab.id)}
              onClose={() => close(tab.id)}
            />
          ))}
        </div>
      )}
      {switcherOpen && (
        <SessionSheet
          tabs={tabs}
          activeId={activeId}
          label={label}
          onPick={(id) => {
            activate(id);
            setSwitcherOpen(false);
          }}
          onCloseTab={close}
          onOpenServer={() => {
            setSwitcherOpen(false);
            useUi.getState().setPaletteOpen(true);
          }}
          onDismiss={() => setSwitcherOpen(false)}
        />
      )}
      {/* Without a local shell (iOS), + opens the search to pick a server. */}
      <Button
        variant="ghost"
        size="icon"
        onClick={hasLocalShell ? openLocal : () => useUi.getState().setPaletteOpen(true)}
        title={t(hasLocalShell ? "tabs.new" : "tabs.openServer")}
        aria-label={t(hasLocalShell ? "tabs.new" : "tabs.openServer")}
      >
        <Plus className="size-4" />
      </Button>
      <div data-tauri-drag-region className="h-full flex-1" />
      <Button
        variant="ghost"
        size="icon"
        onClick={() => useUi.getState().setPaletteOpen(true)}
        title={`${t("palette.title")} (${isMac ? "⌘K" : "Ctrl+Shift+K"})`}
        aria-label={t("palette.title")}
      >
        <Search className="size-4" />
      </Button>
      {(activeTab?.kind === "ssh" || activeTab?.kind === "rdp") && activeTab.hostId && (
        <Button size="sm" onClick={() => openSftp(activeTab.hostId!)} title={t("sidebar.sftp")}>
          <FolderOpen className="size-3.5" />
          <span className="compact:hidden">SFTP</span>
        </Button>
      )}
      {activeTab?.kind === "rdp" && <RdpToolbar tab={activeTab} />}
      {activeTab && isTerminalTab(activeTab) && <QuickCommandsButton />}
      <Button
        size="sm"
        variant={assistantOpen ? "secondary" : "ghost"}
        onClick={toggleAssistant}
        title={`${t("ai.title")} (${isMac ? "⌘I" : "Ctrl+Shift+I"})`}
        aria-pressed={assistantOpen}
      >
        <Sparkles className="size-3.5 text-accent" />
        <span className="compact:hidden">{t("ai.short")}</span>
      </Button>
    </div>
  );
}

interface TabItemProps {
  tab: Tab;
  label: string;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}

function TabItem({ tab, label, active, onActivate, onClose }: TabItemProps) {
  const { t } = useTranslation();
  const accent = useHostAccent(tab.hostId);
  const host = useHosts((s) => (tab.hostId ? s.hosts.find((h) => h.id === tab.hostId) : undefined));
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={tab.kind === "ssh" && tab.title ? tab.title : undefined}
      onClick={onActivate}
      onKeyDown={(e) => e.key === "Enter" && onActivate()}
      onAuxClick={(e) => e.button === 1 && onClose()}
      // The host colour underlines the active tab, matching the stripe over the terminal.
      style={active && accent ? { boxShadow: `inset 0 -2px 0 ${accent.hex}` } : undefined}
      className={cn(
        "group flex h-7 touch:h-9 max-w-52 shrink-0 cursor-pointer items-center gap-2 rounded-btn-sm border pl-2.5 pr-1 text-[13px] transition-colors",
        active ? "border-border bg-card text-fg shadow-sm" : "border-transparent text-fg-muted hover:bg-muted hover:text-fg",
      )}
    >
      <TabIcon tab={tab} active={active} />
      {host && hostOsId(host) && <OsIcon id={hostOsId(host)!} className="-mr-0.5 size-3.5" />}
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={t("tabs.close")}
        className={cn(
          "grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-muted hover:bg-muted hover:text-fg",
          !active && "opacity-0 group-hover:opacity-100 touch:opacity-100",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** Every open session in a list from the bottom of the screen (phones). */
function SessionSheet(props: {
  tabs: Tab[];
  activeId: string | null;
  label: (tab: Tab) => string;
  onPick: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenServer: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={props.onDismiss} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("tabs.sessions", { count: props.tabs.length })}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[75%] overflow-y-auto rounded-t-2xl border-t border-border bg-card px-3 pt-2 pb-[max(env(safe-area-inset-bottom),12px)] shadow-xl"
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border" aria-hidden />
        <p className="px-1 pb-2 text-sm font-semibold text-fg">{t("tabs.sessions", { count: props.tabs.length })}</p>
        <ul className="flex flex-col gap-1.5">
          {props.tabs.map((tab) => (
            <li key={tab.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => props.onPick(tab.id)}
                aria-current={tab.id === props.activeId ? "page" : undefined}
                className={cn(
                  "flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-btn border px-3 text-left text-sm",
                  tab.id === props.activeId ? "border-accent bg-accent/10 text-fg" : "border-border text-fg-secondary",
                )}
              >
                <TabIcon tab={tab} active={tab.id === props.activeId} />
                <span className="truncate">{props.label(tab)}</span>
              </button>
              <button
                type="button"
                onClick={() => props.onCloseTab(tab.id)}
                aria-label={`${t("tabs.close")}: ${props.label(tab)}`}
                className="grid size-12 shrink-0 cursor-pointer place-items-center rounded-btn text-fg-muted active:bg-muted"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        <Button variant="primary" className="mt-3 w-full" onClick={props.onOpenServer}>
          <Plus className="size-4" />
          {t("tabs.openServer")}
        </Button>
      </div>
    </div>
  );
}

function TabIcon({ tab, active }: { tab: Tab; active: boolean }) {
  const className = cn("size-3.5 shrink-0", active && "text-accent");
  switch (tab.kind) {
    case "ssh":
    case "sftp":
    case "ftp":
    case "rdp":
    case "docker":
    case "vms":
      return <StatusDot status={tab.status} />;
    case "keys":
      return <KeyRound className={className} />;
    case "knownHosts":
      return <Fingerprint className={className} />;
    case "status":
      return <Activity className={className} />;
    default:
      return <SquareTerminal className={className} />;
  }
}
