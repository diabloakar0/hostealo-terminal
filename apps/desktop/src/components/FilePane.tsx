import { useEffect, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowUp, Eye, EyeOff, File, FileSymlink, Folder, FolderPlus, FolderSymlink, House, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import i18n from "../i18n";
import { formatBytes } from "../lib/format";
import type { SftpEntry } from "../lib/ipc";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Form";
import { NameDialog } from "./ui/NameDialog";

export type PaneSide = "local" | "remote";

/** Items dragged from one pane to the other. */
export interface PaneDrag {
  side: PaneSide;
  entries: SftpEntry[];
}

const DRAG_TYPE = "application/x-hostealo-files";
/** What is being dragged right now (drag data is not readable until the drop). */
let dragging: PaneDrag | null = null;

function modeString(entry: SftpEntry): string {
  if (entry.permissions === null) return "";
  const chars = "rwxrwxrwx";
  let s = entry.isSymlink ? "l" : entry.isDir ? "d" : "-";
  for (let i = 0; i < 9; i++) s += entry.permissions & (1 << (8 - i)) ? chars[i] : "-";
  return s;
}

function formatDate(seconds: number | null): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
}

type Dialog = { kind: "mkdir" } | { kind: "rename"; entry: SftpEntry } | { kind: "delete"; entries: SftpEntry[] } | null;

export interface FilePaneProps {
  side: PaneSide;
  title: ReactNode;
  icon: ReactNode;
  cwd: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  canGoUp: boolean;
  onUp: () => void;
  onHome: () => void;
  onNavigate: (path: string) => void;
  onMkdir: (name: string) => Promise<void>;
  onRename: (entry: SftpEntry, name: string) => Promise<void>;
  onDelete: (entries: SftpEntry[]) => Promise<void>;
  /** Double click on a file. */
  onOpenFile: (entry: SftpEntry) => void;
  /** Sends the selection to the other side (upload or download). */
  transfer?: { label: string; icon: ReactNode; run: (entries: SftpEntry[]) => void };
  /** Items dropped here from the other pane, into `dir`. */
  onReceive?: (drag: PaneDrag, dir: string) => void;
  showOwner?: boolean;
  toolbar?: ReactNode;
  footer?: ReactNode;
}

/** One side of the file browser: this computer or the server. */
export function FilePane(props: FilePaneProps) {
  const { side, cwd, entries } = props;
  const { t } = useTranslation();
  const [pathInput, setPathInput] = useState(cwd);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Where a drag from the other pane would land: the folder shown (""), or a folder row. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useEffect(() => {
    setPathInput(cwd);
    setSelected(new Set());
  }, [cwd]);

  const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
  const selectedEntries = visible.filter((e) => selected.has(e.path));

  const onRowClick = (entry: SftpEntry, event: MouseEvent) =>
    setSelected((current) => {
      if (event.metaKey || event.ctrlKey) {
        const next = new Set(current);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      }
      return new Set([entry.path]);
    });

  const onDragStart = (entry: SftpEntry, event: DragEvent) => {
    // Dragging a selected row takes the whole selection.
    const items = selected.has(entry.path) ? selectedEntries : [entry];
    dragging = { side, entries: items };
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging));
    event.dataTransfer.effectAllowed = "copy";
  };

  const accepts = () => dragging !== null && dragging.side !== side && !!props.onReceive;
  const dropProps = (dir: string | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!accepts()) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropTarget(dir ?? "");
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return;
      setDropTarget(null);
    },
    onDrop: (event: DragEvent) => {
      if (!accepts()) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      const drag = dragging!;
      dragging = null;
      props.onReceive!(drag, dir ?? cwd);
    },
  });

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={typeof props.title === "string" ? props.title : undefined}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-deep px-3 text-xs font-medium text-fg-secondary">
        {props.icon}
        <span className="truncate">{props.title}</span>
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <ToolbarButton label={t("sftp.up")} onClick={props.onUp} disabled={!props.canGoUp}>
          <ArrowUp className="size-4" />
        </ToolbarButton>
        <ToolbarButton label={t("sftp.home")} onClick={props.onHome}>
          <House className="size-4" />
        </ToolbarButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            props.onNavigate(pathInput.trim() || cwd);
          }}
        >
          <Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} className="h-8 font-mono text-[13px]" aria-label={t("sftp.path")} />
        </form>
        <ToolbarButton label={t("common.refresh")} onClick={() => props.onNavigate(cwd)}>
          <RefreshCw className={cn("size-4", props.loading && "animate-spin")} />
        </ToolbarButton>
        <ToolbarButton label={showHidden ? t("sftp.hideHidden") : t("sftp.showHidden")} onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </ToolbarButton>
        <ToolbarButton label={t("sftp.newFolder")} onClick={() => setDialog({ kind: "mkdir" })}>
          <FolderPlus className="size-4" />
        </ToolbarButton>
        {props.toolbar}
      </div>

      {props.error && <p className="shrink-0 border-b border-border bg-red/10 px-3 py-1.5 text-xs text-red">{props.error}</p>}

      <div
        className={cn("min-h-0 flex-1 overflow-auto", dropTarget === "" && "bg-accent/5 outline-2 -outline-offset-2 outline-accent outline-dashed")}
        onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
        {...dropProps(null)}
      >
        <table className="w-full table-fixed text-[13px]">
          <thead className="sticky top-0 z-10 border-b border-border bg-card text-left text-xs text-fg-muted">
            <tr>
              <th className="px-3 py-2 font-medium">{t("sftp.name")}</th>
              <th className="w-20 px-3 py-2 text-right font-medium">{t("sftp.size")}</th>
              <th className="w-36 px-3 py-2 font-medium">{t("sftp.modified")}</th>
              {side === "remote" && <th className="w-28 px-3 py-2 font-medium">{t("sftp.permissions")}</th>}
              {props.showOwner && <th className="w-24 px-3 py-2 font-medium">{t("sftp.owner")}</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => {
              const isSelected = selected.has(entry.path);
              const Icon = entry.isDir ? (entry.isSymlink ? FolderSymlink : Folder) : entry.isSymlink ? FileSymlink : File;
              return (
                <tr
                  key={entry.path}
                  draggable
                  onDragStart={(e) => onDragStart(entry, e)}
                  onDragEnd={() => (dragging = null)}
                  {...(entry.isDir ? dropProps(entry.path) : {})}
                  onClick={(e) => onRowClick(entry, e)}
                  onDoubleClick={() => (entry.isDir ? props.onNavigate(entry.path) : props.onOpenFile(entry))}
                  className={cn(
                    "cursor-default border-b border-border/60",
                    dropTarget === entry.path ? "bg-accent/15" : isSelected ? "bg-badge" : "hover:bg-muted/50",
                  )}
                >
                  <td className="truncate px-3 py-1.5 text-fg">
                    <span className="flex items-center gap-2">
                      <Icon className={cn("size-4 shrink-0", entry.isDir ? "text-accent" : "text-fg-muted")} />
                      <span className="truncate">{entry.name}</span>
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-fg-secondary">{entry.isDir ? "" : formatBytes(entry.size)}</td>
                  <td className="truncate px-3 py-1.5 tabular-nums text-fg-muted">{formatDate(entry.modified)}</td>
                  {side === "remote" && <td className="truncate px-3 py-1.5 font-mono text-xs text-fg-muted">{modeString(entry)}</td>}
                  {props.showOwner && <td className="truncate px-3 py-1.5 text-fg-muted">{entry.owner}</td>}
                </tr>
              );
            })}
            {visible.length === 0 && !props.loading && (
              <tr>
                <td colSpan={5} className="px-3 py-12 text-center text-sm text-fg-muted">
                  {t("sftp.emptyFolder")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Fixed height: selecting never moves the rows (a double click would land on another one). */}
      <footer className="flex h-10 shrink-0 items-center gap-1.5 border-t border-border bg-deep px-3 text-xs text-fg-muted">
        {selectedEntries.length > 0 ? (
          <>
            <span className="truncate text-fg-secondary">{t("sftp.selected", { count: selectedEntries.length })}</span>
            <div className="flex-1" />
            {props.transfer && (
              <Button size="sm" variant="primary" className="h-7" onClick={() => props.transfer!.run(selectedEntries)}>
                {props.transfer.icon}
                {props.transfer.label}
              </Button>
            )}
            {selectedEntries.length === 1 && (
              <Button size="icon" variant="ghost" onClick={() => setDialog({ kind: "rename", entry: selectedEntries[0] })} title={t("sftp.rename")} aria-label={t("sftp.rename")}>
                <Pencil className="size-3.5" />
              </Button>
            )}
            <Button size="icon" variant="ghost" className="hover:text-red" onClick={() => setDialog({ kind: "delete", entries: selectedEntries })} title={t("sidebar.delete")} aria-label={t("sidebar.delete")}>
              <Trash2 className="size-3.5" />
            </Button>
          </>
        ) : (
          <>
            <span className="shrink-0">{t("sftp.items", { count: visible.length })}</span>
            <span className="mx-1.5 shrink-0">·</span>
            {props.footer}
          </>
        )}
      </footer>

      {dialog?.kind === "mkdir" && (
        <NameDialog title={t("sftp.newFolder")} icon={<Folder className="size-4" />} initial="" onClose={() => setDialog(null)} onSubmit={props.onMkdir} />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={t("sftp.rename")}
          icon={<Pencil className="size-4" />}
          initial={dialog.entry.name}
          onClose={() => setDialog(null)}
          onSubmit={(name) => props.onRename(dialog.entry, name)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog title={t("sftp.deleteTitle")} confirmLabel={t("sidebar.delete")} onConfirm={() => props.onDelete(dialog.entries)} onClose={() => setDialog(null)}>
          {dialog.entries.length === 1 ? (
            <Trans
              i18nKey={dialog.entries[0].isDir ? "sftp.deleteFolder" : "sftp.deleteFile"}
              values={{ name: dialog.entries[0].name }}
              components={{ b: <strong className="font-mono text-fg" /> }}
            />
          ) : (
            t("sftp.deleteMany", { count: dialog.entries.length })
          )}
          {side === "local" && <p className="mt-2 text-xs text-fg-muted">{t("files.localDeleteNote")}</p>}
        </ConfirmDialog>
      )}
    </section>
  );
}

export function ToolbarButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon" className="size-8" onClick={onClick} disabled={disabled} title={label} aria-label={label}>
      {children}
    </Button>
  );
}
