import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowLeftRight,
  Cloud,
  Container,
  CornerDownLeft,
  Fingerprint,
  FolderOpen,
  Import,
  KeyRound,
  Layers,
  Monitor,
  Plus,
  Search,
  Server,
  Settings,
  Sparkles,
  SquareTerminal,
  Zap,
} from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { hasLocalShell, isMac } from "../lib/format";
import { matches } from "../lib/search";
import type { Host } from "../lib/ipc";
import { getTerminal } from "../lib/terminals";
import { useAi } from "../store/ai";
import { useHostealo } from "../store/hostealo";
import { useHosts } from "../store/hosts";
import { isTerminalTab, useTabs } from "../store/tabs";
import { useUi } from "../store/ui";
import { hostOsId, OsIcon } from "./OsIcon";
import { StatusDot } from "./StatusDot";

interface Item {
  id: string;
  group: "servers" | "tabs" | "commands" | "actions";
  title: string;
  subtitle?: string;
  icon: ReactNode;
  /** Words the search looks in, besides the title and subtitle. */
  keywords?: string;
  /** Enter. `fresh`: ⌘/Ctrl+Enter (a new session for a server). */
  run: (fresh: boolean) => void;
}

interface CommandPaletteProps {
  onOpenHost: (host: Host, fresh?: boolean) => void;
  onNewHost: () => void;
  onOpenSettings: () => void;
}

const GROUP_ORDER: Item["group"][] = ["tabs", "servers", "commands", "actions"];
/** With no query, a few of each so the list fits. */
const EMPTY_LIMIT = 6;

/** ⌘K: jump to any server, tab, quick command or action. */
export function CommandPalette(props: CommandPaletteProps) {
  const open = useUi((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette {...props} onClose={() => useUi.getState().setPaletteOpen(false)} />;
}

function Palette({ onOpenHost, onNewHost, onOpenSettings, onClose }: CommandPaletteProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const hosts = useHosts((s) => s.hosts);
  const snippets = useHosts((s) => s.snippets);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);

  const activeTab = tabs.find((tab) => tab.id === activeId);
  const terminal = activeTab && isTerminalTab(activeTab) ? getTerminal(activeId) : undefined;

  const items = useMemo<Item[]>(() => {
    const hostName = (id: string | null) => hosts.find((h) => h.id === id)?.name ?? "";
    const tabTitle = (kind: string, id: string | null) =>
      kind === "local" ? t("tabs.local") : kind === "status" ? t("status.title") : kind === "keys" ? t("keys.title") : kind === "knownHosts" ? t("knownHosts.title") : `${hostName(id)} · ${kind.toUpperCase()}`;
    return [
      ...tabs
        .filter((tab) => tab.id !== activeId)
        .map<Item>((tab) => ({
          id: `tab:${tab.id}`,
          group: "tabs",
          title: tab.kind === "ssh" ? hostName(tab.hostId) : tabTitle(tab.kind, tab.hostId),
          subtitle: t("palette.goToTab"),
          icon: tab.hostId ? <StatusDot status={tab.status} /> : <SquareTerminal />,
          run: () => useTabs.getState().activate(tab.id),
        })),
      ...hosts.map<Item>((host) => {
        const osId = hostOsId(host);
        return {
          id: `host:${host.id}`,
          group: "servers",
          title: host.name,
          subtitle: [host.folder, `${host.username}@${host.hostname}`].filter(Boolean).join(" · "),
          keywords: `${host.protocol} ${host.os?.name ?? ""}`,
          icon: osId ? <OsIcon id={osId} /> : host.protocol === "rdp" ? <Monitor /> : host.protocol === "ssh" ? <Server /> : <FolderOpen />,
          run: (fresh) => onOpenHost(host, fresh),
        };
      }),
      ...snippets.map<Item>((snippet) => ({
        id: `snippet:${snippet.id}`,
        group: "commands",
        title: snippet.name,
        subtitle: snippet.command.replace(/\n/g, " ⏎ "),
        icon: <Zap />,
        run: () => {
          // Typed, not run: Enter in the terminal is the user's.
          terminal?.insert(snippet.command);
          terminal?.focus();
        },
      })),
      ...(
        [
          ...(hasLocalShell ? [["newLocal", <SquareTerminal />, t("palette.newLocal"), () => useTabs.getState().openLocal()] as const] : []),
          ["newHost", <Plus />, t("sidebar.newHost"), onNewHost],
          ["status", <Activity />, t("status.title"), () => useTabs.getState().openPage("status")],
          ["keys", <KeyRound />, t("keys.title"), () => useTabs.getState().openPage("keys")],
          ["knownHosts", <Fingerprint />, t("knownHosts.title"), () => useTabs.getState().openPage("knownHosts")],
          ["import", <Import />, t("import.title"), () => useUi.getState().setImportOpen(true)],
          ["sync", <ArrowLeftRight />, t("sync.title"), () => useUi.getState().setSyncOpen(true)],
          ["hostealo", <Cloud />, t("hostealo.title"), () => useHostealo.getState().setDialogOpen(true)],
          ["assistant", <Sparkles />, t("ai.title"), () => useAi.getState().setOpen(true)],
          ["settings", <Settings />, t("settings.title"), onOpenSettings],
        ] as const
      ).map<Item>(([id, icon, title, run]) => ({ id: `action:${id}`, group: "actions", title, icon, run: () => run() })),
      ...hosts
        .filter((host) => host.protocol === "ssh")
        .map<Item>((host) => ({
          id: `docker:${host.id}`,
          group: "actions",
          title: `Docker · ${host.name}`,
          icon: <Container />,
          run: () => useTabs.getState().openDocker(host.id),
        })),
      ...hosts
        .filter((host) => host.protocol === "ssh")
        .map<Item>((host) => ({
          id: `vms:${host.id}`,
          group: "actions",
          title: `${t("vms.short")} · ${host.name}`,
          keywords: "proxmox kvm virsh solusvm vm",
          icon: <Layers />,
          run: () => useTabs.getState().openVms(host.id),
        })),
    ];
  }, [hosts, snippets, tabs, activeId, t, onOpenHost, onNewHost, onOpenSettings, terminal]);

  const shown = useMemo(() => {
    const q = query.trim();
    const found = q ? items.filter((item) => matches(q, `${item.title} ${item.subtitle ?? ""} ${item.keywords ?? ""}`)) : items;
    // Commands only make sense with a terminal to type into.
    const usable = found.filter((item) => item.group !== "commands" || terminal);
    return GROUP_ORDER.flatMap((group) => {
      const inGroup = usable.filter((item) => item.group === group);
      return q ? inGroup : inGroup.slice(0, EMPTY_LIMIT);
    });
  }, [items, query, terminal]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    input.current?.focus();
    const focus = previousFocus.current;
    return () => focus?.focus();
  }, []);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (item: Item | undefined, fresh: boolean) => {
    if (!item) return;
    // Close first, so whatever the item opens gets the focus.
    previousFocus.current = null;
    onClose();
    item.run(fresh);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelected((i) => (shown.length ? (i + step + shown.length) % shown.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[selected], e.metaKey || e.ctrlKey);
    }
  };

  const heading = (group: Item["group"]) => t(`palette.groups.${group}`);

  return createPortal(
    <div className="fixed inset-0 z-[65] flex justify-center bg-black/40 px-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={t("palette.title")} onKeyDown={onKeyDown} className="v2-menu flex h-fit max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl shadow-lg">
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-fg-muted" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.placeholder")}
            spellCheck={false}
            autoComplete="off"
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-muted/70"
          />
          <kbd className="rounded border border-border px-1.5 text-[11px] text-fg-muted">Esc</kbd>
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {shown.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-fg-muted">{t("palette.nothing")}</p>
          ) : (
            shown.map((item, index) => (
              <div key={item.id}>
                {(index === 0 || shown[index - 1].group !== item.group) && (
                  <p className="px-2.5 pt-2 pb-1 text-xs font-medium text-fg-muted">{heading(item.group)}</p>
                )}
                <button
                  type="button"
                  data-index={index}
                  onMouseMove={() => setSelected(index)}
                  onClick={(e) => choose(item, e.metaKey || e.ctrlKey)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm",
                    index === selected ? "bg-muted text-fg" : "text-fg-secondary",
                  )}
                >
                  <span className="grid size-4 shrink-0 place-items-center text-fg-muted [&>svg]:size-4">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-fg">{item.title}</span>
                    {item.subtitle && <span className={cn("ml-2 text-xs text-fg-muted", item.group === "commands" && "font-mono")}>{item.subtitle}</span>}
                  </span>
                  {index === selected && <CornerDownLeft className="size-3.5 shrink-0 text-fg-muted" />}
                </button>
              </div>
            ))
          )}
        </div>
        <p className="border-t border-border px-4 py-2 text-[11px] text-fg-muted">
          {t("palette.keys", { modifier: isMac ? "⌘" : "Ctrl" })}
        </p>
      </div>
    </div>,
    document.body,
  );
}
