// The "Servers" group of the sidebar, styled like the client panel v2 navigation: folders are
// collapsible groups with a count pill, and their contents hang off ├ └ tree guides.
import { useMemo, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ChevronRight,
  Container,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  Import,
  KeyRound,
  Layers,
  Monitor,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCw,
  Search,
  Server,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { homeDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { isMac } from "../lib/format";
import { hostealoPower, hostealoResetPassword, type Host, type PowerAction } from "../lib/ipc";
import { useHostAccent } from "../hooks/useHostColor";
import { useHosts } from "../store/hosts";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { hostTabKind, isEnded, useTabs, type TabStatus } from "../store/tabs";
import { ConfirmDialog } from "./ConfirmDialog";
import { StatusDot, worstStatus } from "./StatusDot";
import { Button } from "./ui/Button";
import { Menu, type MenuAnchor, type MenuEntry } from "./ui/Menu";
import { NameDialog } from "./ui/NameDialog";
import { hostOsId, OsIcon } from "./OsIcon";

/** Drag-and-drop payload type for moving a host into a folder. */
const HOST_MIME = "application/x-hostealo-host";

interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  hosts: Host[];
  /** Hosts in this folder and all its subfolders. */
  hostIds: string[];
}

function buildTree(hosts: Host[], folders: string[]): FolderNode {
  const root: FolderNode = { path: "", name: "", folders: [], hosts: [], hostIds: [] };
  const nodes = new Map<string, FolderNode>([["", root]]);
  const ensure = (path: string): FolderNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensure(slash === -1 ? "" : path.slice(0, slash));
    const node: FolderNode = { path, name: path.slice(slash + 1), folders: [], hosts: [], hostIds: [] };
    parent.folders.push(node);
    nodes.set(path, node);
    return node;
  };
  folders.forEach(ensure);
  for (const host of hosts) ensure(host.folder ?? "").hosts.push(host);

  const finish = (node: FolderNode): string[] => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    node.hostIds = [...node.hosts.map((h) => h.id), ...node.folders.flatMap(finish)];
    return node.hostIds;
  };
  finish(root);
  return root;
}

const matches = (host: Host, query: string) =>
  [host.name, host.hostname, host.username, host.folder ?? ""].some((field) => field.toLowerCase().includes(query));

type FolderDialog = { kind: "create"; parent: string } | { kind: "rename"; path: string } | { kind: "delete"; node: FolderNode } | null;

interface DropHandlers {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}

interface HostTreeProps {
  /** Goes to the host's open session (or reconnects an ended one); `fresh` opens another. */
  onConnect: (host: Host, fresh?: boolean) => void;
  onOpenSftp: (host: Host) => void;
  onNewHost: (folder: string | null) => void;
  onEditHost: (host: Host) => void;
  onDeleteHost: (host: Host) => void;
}

export function HostTree(props: HostTreeProps) {
  const { t } = useTranslation();
  const { hosts, folders, loaded, error, move, createFolder, renameFolder, deleteFolder } = useHosts();
  const tabs = useTabs((s) => s.tabs);
  const activeHostId = useTabs((s) => s.tabs.find((tab) => tab.id === s.activeId)?.hostId ?? null);
  const collapsed = useSettings((s) => s.collapsedFolders);
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<FolderDialog>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(null);
  const setImporting = useUi((s) => s.setImportOpen);
  const [power, setPower] = useState<{ host: Host; action: PowerAction } | null>(null);
  const [resetting, setResetting] = useState<Host | null>(null);

  const tree = useMemo(() => buildTree(hosts, folders), [hosts, folders]);
  const query = filter.trim().toLowerCase();

  // Most relevant status among the tabs open on each host.
  const statusByHost = useMemo(() => {
    const map = new Map<string, TabStatus>();
    for (const tab of tabs) {
      if (tab.hostId) map.set(tab.hostId, worstStatus([map.get(tab.hostId), tab.status])!);
    }
    return map;
  }, [tabs]);

  const isOpen = (path: string) => !collapsed.includes(path);
  const toggle = (path: string) => {
    const { collapsedFolders, update } = useSettings.getState();
    update({ collapsedFolders: isOpen(path) ? [...collapsedFolders, path] : collapsedFolders.filter((p) => p !== path) });
  };

  const openMenu = (event: MouseEvent, entries: MenuEntry[]) => {
    event.preventDefault();
    event.stopPropagation();
    const anchor: MenuAnchor =
      event.type === "contextmenu"
        ? { x: event.clientX, y: event.clientY }
        : { rect: (event.currentTarget as HTMLElement).getBoundingClientRect(), placement: "below" };
    setMenu({ anchor, entries });
  };

  const hostEntries = (host: Host): MenuEntry[] => {
    const live = tabs.some((tab) => tab.hostId === host.id && tab.kind === hostTabKind(host.protocol) && !isEnded(tab));
    const icon = host.protocol === "ssh" ? <SquareTerminal /> : host.protocol === "rdp" ? <Monitor /> : <FolderOpen />;
    const connect = host.protocol === "ssh" ? t("hostMenu.connect") : host.protocol === "rdp" ? t("hostMenu.connectRdp") : t("hostMenu.openFiles");
    return [
      // With a session open, a click goes back to it; another one is opened from here.
      ...(live
        ? [
            { label: t("hostMenu.goToSession"), icon, onSelect: () => props.onConnect(host) },
            { label: t("hostMenu.newSession"), icon: <Plus />, hint: isMac ? "⌘ clic" : "Ctrl+clic", onSelect: () => props.onConnect(host, true) },
          ]
        : [{ label: connect, icon, onSelect: () => props.onConnect(host) }]),
      ...(host.protocol === "ssh"
        ? [
            { label: t("hostMenu.docker"), icon: <Container />, onSelect: () => useTabs.getState().openDocker(host.id) },
            { label: t("hostMenu.vms"), icon: <Layers />, onSelect: () => useTabs.getState().openVms(host.id) },
          ]
        : []),
      // Windows servers too: their files go over OpenSSH (same user and password).
      ...(host.protocol === "ssh" || host.protocol === "rdp"
        ? [{ label: t("sidebar.sftp"), icon: <FolderOpen />, onSelect: () => props.onOpenSftp(host) }]
        : []),
      ...(host.protocol === "rdp" && host.rdpSharedFolder
        ? [
            {
              label: t("hostMenu.openSharedFolder"),
              icon: <FolderSymlink />,
              hint: host.rdpSharedFolder,
              onSelect: () => void revealSharedFolder(host.rdpSharedFolder!),
            },
          ]
        : []),
      ...(host.hostealo?.kind === "vps"
        ? [
            { separator: true as const },
            { heading: "Hostealo" },
            { label: t("hostealo.power.start"), icon: <Play />, onSelect: () => setPower({ host, action: "start" as const }) },
            { label: t("hostealo.power.restart"), icon: <RotateCw />, onSelect: () => setPower({ host, action: "restart" as const }) },
            { label: t("hostealo.power.stop"), icon: <Power />, danger: true, onSelect: () => setPower({ host, action: "stop" as const }) },
            { label: t("hostealo.resetPassword"), icon: <KeyRound />, onSelect: () => setResetting(host) },
          ]
        : []),
      { separator: true },
      { label: t("sidebar.edit"), icon: <Pencil />, onSelect: () => props.onEditHost(host) },
      ...(host.folder ? [{ label: t("hostMenu.moveToTop"), icon: <Folder />, onSelect: () => void move(host, null) }] : []),
      { separator: true },
      { label: t("sidebar.delete"), icon: <Trash2 />, danger: true, onSelect: () => props.onDeleteHost(host) },
    ];
  };

  const folderEntries = (node: FolderNode): MenuEntry[] => [
    { label: t("sidebar.newHost"), icon: <Plus />, onSelect: () => props.onNewHost(node.path) },
    { label: t("folders.newSub"), icon: <FolderPlus />, onSelect: () => setDialog({ kind: "create", parent: node.path }) },
    { label: t("folders.rename"), icon: <Pencil />, onSelect: () => setDialog({ kind: "rename", path: node.path }) },
    { separator: true },
    { label: t("sidebar.delete"), icon: <Trash2 />, danger: true, onSelect: () => setDialog({ kind: "delete", node }) },
  ];

  const dropHandlers = (folder: string): DropHandlers => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(HOST_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((current) => (current === folder ? null : current)),
    onDrop: (e) => {
      const host = hosts.find((h) => h.id === e.dataTransfer.getData(HOST_MIME));
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      if (host) void move(host, folder || null);
    },
  });

  const hostProps = (host: Host) => ({
    host,
    status: statusByHost.get(host.id),
    active: host.id === activeHostId,
    onConnect: (fresh: boolean) => props.onConnect(host, fresh),
    onMenu: (e: MouseEvent) => openMenu(e, hostEntries(host)),
  });

  /** Folder contents inside a tree (`small` from the second level down, like the panel). */
  const renderChildren = (node: FolderNode, small: boolean): ReactNode => (
    <ul className={cn("v2-tree", small && "v2-tree-sm")}>
      {node.folders.map((child) => {
        const open = isOpen(child.path);
        return (
          <li key={child.path} className={cn(child.hostIds.includes(activeHostId ?? "") && !open && "is-active")}>
            <div
              {...dropHandlers(child.path)}
              onContextMenu={(e) => openMenu(e, folderEntries(child))}
              className={cn("group flex items-center gap-0.5 rounded-md", dropTarget === child.path && "bg-badge ring-1 ring-accent")}
            >
              <button
                type="button"
                onClick={() => toggle(child.path)}
                className={cn("v2-nav-link v2-nav-child flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1", small && "text-xs")}
              >
                {open ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate text-left">{child.name}</span>
                {!open && <RolledUp ids={child.hostIds} statusByHost={statusByHost} />}
                <span className="text-xs tabular-nums text-fg-muted">{child.hostIds.length}</span>
              </button>
              <button
                type="button"
                onClick={() => toggle(child.path)}
                aria-expanded={open}
                aria-label={child.name}
                className="v2-tree-toggle grid size-6 shrink-0 cursor-pointer place-items-center rounded-md"
              >
                <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
              </button>
            </div>
            {open && (child.folders.length > 0 || child.hosts.length > 0) && renderChildren(child, true)}
          </li>
        );
      })}
      {node.hosts.map((host) => (
        <li key={host.id} className={cn(host.id === activeHostId && "is-active")}>
          <TreeHostItem {...hostProps(host)} small={small} />
        </li>
      ))}
    </ul>
  );

  return (
    <section {...dropHandlers("")} className={cn("rounded-lg", dropTarget === "" && "bg-badge")}>
      <header className="flex items-center justify-between pb-1.5 pl-2">
        <p className="text-xs font-medium text-fg-muted">{t("sidebar.hosts")}</p>
        <span className="flex">
          <Button variant="ghost" size="icon" className="size-6" onClick={() => setImporting(true)} title={t("import.title")} aria-label={t("import.title")}>
            <Import className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" onClick={() => setDialog({ kind: "create", parent: "" })} title={t("folders.new")} aria-label={t("folders.new")}>
            <FolderPlus className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" onClick={() => props.onNewHost(null)} title={t("sidebar.newHost")} aria-label={t("sidebar.newHost")}>
            <Plus className="size-3.5" />
          </Button>
        </span>
      </header>

      {hosts.length > 0 && (
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            placeholder={t("sidebar.filter")}
            spellCheck={false}
            className="h-8 w-full rounded-md border border-input-border bg-input pl-8 pr-7 text-[13px] text-fg shadow-sm outline-none select-text placeholder:text-fg-muted/70 focus:border-fg-muted focus:ring-4 focus:ring-ring"
          />
          {filter && (
            <button type="button" onClick={() => setFilter("")} className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-fg-muted hover:text-fg" aria-label={t("common.clear")}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {error && <p className="px-2 text-xs text-red">{error}</p>}
      {loaded && hosts.length === 0 && folders.length === 0 && !error && <EmptyHosts onNewHost={() => props.onNewHost(null)} onImport={() => setImporting(true)} />}
      {power && (
        <ConfirmDialog
          title={t(`hostealo.power.${power.action}Title`, { name: power.host.name })}
          confirmLabel={t(`hostealo.power.${power.action}`)}
          icon={power.action === "start" ? <Play className="size-4" /> : power.action === "restart" ? <RotateCw className="size-4" /> : <Power className="size-4" />}
          danger={power.action !== "start"}
          onConfirm={async () => {
            await hostealoPower(power.host.hostealo!.serviceId, power.action);
          }}
          onClose={() => setPower(null)}
        >
          {t(`hostealo.power.${power.action}Body`)}
        </ConfirmDialog>
      )}

      {resetting && (
        <ConfirmDialog
          title={t("hostealo.resetPasswordTitle", { name: resetting.name })}
          confirmLabel={t("hostealo.resetPasswordConfirm")}
          icon={<KeyRound className="size-4" />}
          onConfirm={async () => {
            await hostealoResetPassword(resetting.id);
            await useHosts.getState().load();
          }}
          onClose={() => setResetting(null)}
        >
          {t("hostealo.resetPasswordBody")}
        </ConfirmDialog>
      )}

      <ul className="space-y-0.5">
        {query ? (
          <>
            {hosts
              .filter((h) => matches(h, query))
              .map((host) => (
                <li key={host.id}>
                  <TopHostItem {...hostProps(host)} subtitle={host.folder ?? undefined} />
                </li>
              ))}
            {!hosts.some((h) => matches(h, query)) && <li className="px-2 py-1.5 text-xs text-fg-muted">{t("sidebar.noMatches")}</li>}
          </>
        ) : (
          <>
            {tree.folders.map((node) => {
              const open = isOpen(node.path);
              const containsActive = node.hostIds.includes(activeHostId ?? "");
              return (
                <li key={node.path} {...dropHandlers(node.path)}>
                  <div className="group relative" onContextMenu={(e) => openMenu(e, folderEntries(node))}>
                    <button
                      type="button"
                      onClick={() => toggle(node.path)}
                      aria-expanded={open}
                      data-section-active={containsActive || undefined}
                      className={cn(
                        "v2-nav-link v2-nav-parent flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left touch:py-2.5",
                        dropTarget === node.path && "bg-badge ring-1 ring-accent",
                      )}
                    >
                      <Folder className="size-4 shrink-0" strokeWidth={1.8} />
                      <span className="min-w-0 flex-1 truncate">{node.name}</span>
                      {!open && <RolledUp ids={node.hostIds} statusByHost={statusByHost} />}
                      {!open && <span className="v2-count rounded-md px-1.5 text-xs font-medium tabular-nums">{node.hostIds.length}</span>}
                      <ChevronRight className={cn("size-4 shrink-0 text-fg-muted transition-transform group-hover:opacity-0", open && "rotate-90")} strokeWidth={1.8} />
                    </button>
                    <MoreButton label={t("hostMenu.more")} onClick={(e) => openMenu(e, folderEntries(node))} />
                  </div>
                  {open && (node.folders.length > 0 || node.hosts.length > 0) && renderChildren(node, false)}
                </li>
              );
            })}
            {tree.hosts.map((host) => (
              <li key={host.id}>
                <TopHostItem {...hostProps(host)} />
              </li>
            ))}
          </>
        )}
      </ul>

      {menu && <Menu anchor={menu.anchor} entries={menu.entries} onClose={() => setMenu(null)} />}

      {dialog?.kind === "create" && (
        <NameDialog
          title={dialog.parent ? t("folders.newIn", { parent: dialog.parent }) : t("folders.new")}
          icon={<FolderPlus className="size-4" />}
          label={t("folders.name")}
          initial=""
          onClose={() => setDialog(null)}
          onSubmit={(name) => createFolder(dialog.parent ? `${dialog.parent}/${name}` : name)}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={t("folders.rename")}
          icon={<Pencil className="size-4" />}
          label={t("folders.path")}
          allowSlash
          initial={dialog.path}
          onClose={() => setDialog(null)}
          onSubmit={(to) => renameFolder(dialog.path, to)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={t("folders.deleteTitle")}
          confirmLabel={t("sidebar.delete")}
          onConfirm={() => deleteFolder(dialog.node.path)}
          onClose={() => setDialog(null)}
        >
          <Trans
            i18nKey={dialog.node.hostIds.length > 0 ? "folders.deleteBodyHosts" : "folders.deleteBody"}
            values={{ name: dialog.node.name, count: dialog.node.hostIds.length }}
            components={{ b: <strong className="text-fg" /> }}
          />
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Status of a collapsed folder: the most relevant one among its hosts, if any is open. */
function RolledUp({ ids, statusByHost }: { ids: string[]; statusByHost: Map<string, TabStatus> }) {
  const status = worstStatus(ids.map((id) => statusByHost.get(id)));
  return status ? <StatusDot status={status} /> : null;
}

function MoreButton({ label, onClick }: { label: string; onClick: (e: MouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="v2-tree-toggle absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md group-hover:grid group-focus-within:grid"
    >
      <Ellipsis className="size-4" />
    </button>
  );
}

interface HostItemProps {
  host: Host;
  status: TabStatus | undefined;
  active: boolean;
  /** `fresh`: ⌘/Ctrl+click, a new session even if one is open. */
  onConnect: (fresh: boolean) => void;
  onMenu: (e: MouseEvent) => void;
}

/** Shows a remote desktop's shared folder in Finder or Explorer (`~` is the home folder). */
async function revealSharedFolder(path: string) {
  const absolute = path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? await join(await homeDir(), path.slice(2)) : path;
  await revealItemInDir(absolute);
}

/** Shown on hover: the system, then the address. */
const hostTitle = (host: Host) => [host.os?.name, `${host.username}@${host.hostname}`].filter(Boolean).join(" · ");

/** A host's logo takes its colour tag when one was chosen, else the brand colour. */
const logoColor = (host: Host, accent: { hex: string } | null) =>
  host.color && host.color !== "none" && accent ? accent.hex : undefined;

const dragProps = (host: Host) => ({
  draggable: true,
  onDragStart: (e: DragEvent) => {
    e.dataTransfer.setData(HOST_MIME, host.id);
    e.dataTransfer.effectAllowed = "move";
  },
});

/** A host at the top level: a regular nav link with an icon, like the panel's top items. */
function TopHostItem({ host, status, active, onConnect, onMenu, subtitle }: HostItemProps & { subtitle?: string }) {
  const { t } = useTranslation();
  const accent = useHostAccent(host.id);
  return (
    <div className="group relative" onContextMenu={onMenu} {...dragProps(host)}>
      <button
        type="button"
        onClick={(e) => onConnect(e.metaKey || e.ctrlKey)}
        aria-current={active ? "page" : undefined}
        title={hostTitle(host)}
        className="v2-nav-link flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left touch:py-2.5"
      >
        {hostOsId(host) ? (
          <OsIcon id={hostOsId(host)!} color={logoColor(host, accent)} />
        ) : host.protocol === "ssh" ? (
          <Server className="size-4 shrink-0" strokeWidth={1.8} style={accent ? { color: accent.hex } : undefined} />
        ) : host.protocol === "rdp" ? (
          <Monitor className="size-4 shrink-0" strokeWidth={1.8} style={accent ? { color: accent.hex } : undefined} />
        ) : (
          <FolderOpen className="size-4 shrink-0" strokeWidth={1.8} style={accent ? { color: accent.hex } : undefined} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{host.name}</span>
          {subtitle && <span className="block truncate text-xs text-fg-muted">{subtitle}</span>}
        </span>
        {status && <StatusDot status={status} className="group-hover:opacity-0" />}
      </button>
      <MoreButton label={t("hostMenu.more")} onClick={onMenu} />
    </div>
  );
}

/** A host inside a folder: a tree child with its colour mark and status dot. */
function TreeHostItem({ host, status, active, onConnect, onMenu, small }: HostItemProps & { small: boolean }) {
  const { t } = useTranslation();
  const accent = useHostAccent(host.id);
  return (
    <div className="group relative" onContextMenu={onMenu} {...dragProps(host)}>
      <button
        type="button"
        onClick={(e) => onConnect(e.metaKey || e.ctrlKey)}
        aria-current={active ? "page" : undefined}
        title={hostTitle(host)}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left touch:py-2",
          small ? "v2-nav-link v2-nav-leaf text-xs" : "v2-nav-link v2-nav-child",
        )}
      >
        {hostOsId(host) ? (
          <OsIcon id={hostOsId(host)!} color={logoColor(host, accent)} className={small ? "size-3" : "size-3.5"} />
        ) : (
          <span className="size-2 shrink-0 rounded-[3px]" style={{ background: accent?.hex ?? "var(--text-muted)", opacity: accent ? 1 : 0.5 }} />
        )}
        <span className="min-w-0 flex-1 truncate">{host.name}</span>
        {status && <StatusDot status={status} small={small} className="group-hover:opacity-0" />}
      </button>
      <MoreButton label={t("hostMenu.more")} onClick={onMenu} />
    </div>
  );
}

function EmptyHosts({ onNewHost, onImport }: { onNewHost: () => void; onImport: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-border bg-card p-3 shadow-sm">
      <p className="text-sm font-medium text-fg">{t("sidebar.noHosts")}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{t("sidebar.noHostsHint")}</p>
      <Button variant="primary" size="sm" className="mt-2.5 w-full" onClick={onNewHost}>
        <Plus className="size-3.5" />
        {t("sidebar.newHost")}
      </Button>
      <Button size="sm" className="mt-1.5 w-full" onClick={onImport}>
        <Import className="size-3.5" />
        {t("import.fromOther")}
      </Button>
    </div>
  );
}
