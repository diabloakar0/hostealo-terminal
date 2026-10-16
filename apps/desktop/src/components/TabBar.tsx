import { useTranslation } from "react-i18next";
import { Activity, Fingerprint, FolderOpen, KeyRound, Plus, Search, Sparkles, SquareTerminal, X } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { isMac } from "../lib/format";
import { useAi } from "../store/ai";
import { useHosts } from "../store/hosts";
import { useHostAccent } from "../hooks/useHostColor";
import { isTerminalTab, useTabs, type Tab } from "../store/tabs";
import { QuickCommandsButton } from "./QuickCommands";
import { RdpToolbar } from "./RdpToolbar";
import { useUi } from "../store/ui";
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
    <div data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
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
      <Button variant="ghost" size="icon" onClick={openLocal} title={t("tabs.new")} aria-label={t("tabs.new")}>
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
          SFTP
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
        {t("ai.short")}
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
        "group flex h-7 max-w-52 shrink-0 cursor-pointer items-center gap-2 rounded-btn-sm border pl-2.5 pr-1 text-[13px] transition-colors",
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
          !active && "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" />
      </button>
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
