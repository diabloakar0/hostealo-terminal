import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Download, FolderUp, Laptop, LoaderCircle, PanelLeft, RefreshCw, Server, Upload, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { cn } from "@hostealo/ui/cn";

import { formatBytes } from "../lib/format";
import { ftpApi, sftpApi, type FileApi } from "../lib/files";
import { localDelete, localHome, localList, localMkdir, localRename, type SftpEntry, type TransferProgress } from "../lib/ipc";
import { useHostAccent } from "../hooks/useHostColor";
import { useHosts } from "../store/hosts";
import { usePrompts } from "../store/prompts";
import { useSettings } from "../store/settings";
import { useTabs, type Tab } from "../store/tabs";
import { FilePane, ToolbarButton, type PaneDrag } from "./FilePane";
import { Button } from "./ui/Button";

interface Transfer {
  id: number;
  direction: "up" | "down";
  label: string;
  progress: TransferProgress | null;
  state: "running" | "done" | "failed" | "cancelled";
  error?: string;
}

let nextTransferId = 1;

const parentOf = (path: string) => path.replace(/\/[^/]+\/?$/, "") || "/";
const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

/**
 * File browser for SFTP and FTP/FTPS tabs, in two panes like FileZilla: this computer on the
 * left, the server on the right. Drag between them, or double-click a file, to copy it across.
 */
export function FilesView({ tab, active }: { tab: Tab; active: boolean }) {
  const api: FileApi = tab.kind === "ftp" ? ftpApi : sftpApi;
  const { t } = useTranslation();
  const accent = useHostAccent(tab.hostId);
  const hostName = useHosts((s) => s.hosts.find((h) => h.id === tab.hostId)?.name ?? "");
  const windowsHost = useHosts((s) => s.hosts.find((h) => h.id === tab.hostId)?.protocol === "rdp");
  const showLocal = useSettings((s) => s.filesShowLocal);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragging, setDragging] = useState(false);

  // The server side.
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // This computer's side.
  const [localCwd, setLocalCwd] = useState("");
  const [localParent, setLocalParent] = useState<string | null>(null);
  const [localEntries, setLocalEntries] = useState<SftpEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const localHomeRef = useRef("");

  const navigate = useCallback(
    async (path: string, id = sessionId) => {
      if (id === null) return;
      setLoading(true);
      try {
        setEntries(await api.list(id, path));
        setCwd(path);
        setListError(null);
      } catch (e) {
        setListError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId, api],
  );

  const navigateLocal = useCallback(async (path: string) => {
    setLocalLoading(true);
    try {
      const listing = await localList(path);
      setLocalEntries(listing.entries);
      setLocalCwd(listing.path);
      setLocalParent(listing.parent);
      setLocalError(null);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setLocalLoading(false);
    }
  }, []);

  useEffect(() => {
    void localHome().then((path) => {
      localHomeRef.current = path;
      void navigateLocal(path);
    });
  }, [navigateLocal]);

  // Connect (and reconnect when `attempt` changes).
  useEffect(() => {
    const tabs = useTabs.getState();
    let id: number | null = null;
    let connected = false;
    let disposed = false;

    // Runs once both the session id and the "connected" event are known (in either order).
    const start = () => {
      if (disposed || id === null || !connected) return;
      const session = id;
      api.realpath(session, ".")
        .then((path) => {
          if (disposed) return;
          setHome(path);
          setSessionId(session);
          void navigate(path, session);
        })
        .catch((e) => setConnectError(String(e)));
    };
    setConnectError(null);
    setSessionId(null);
    tabs.setStatus(tab.id, "connecting");

    api.open(tab.hostId!, (event) => {
      if (disposed) return;
      switch (event.type) {
        case "status":
          tabs.setStatus(tab.id, event.stage);
          if (event.stage === "connected") {
            connected = true;
            start();
          }
          return;
        case "hostKey":
        case "certificate":
        case "prompt":
          usePrompts.getState().enqueue({ ...event, tabId: tab.id, hostId: tab.hostId! });
          return;
        case "closed":
          usePrompts.getState().dropForTab(tab.id);
          tabs.setStatus(tab.id, event.error ? "failed" : "closed");
          setConnectError(event.error ?? t("sftp.disconnected"));
          return;
      }
    })
      .then((opened) => {
        if (disposed) {
          void api.close(opened);
          return;
        }
        id = opened;
        start();
      })
      .catch((e) => {
        tabs.setStatus(tab.id, "failed");
        setConnectError(String(e));
      });

    return () => {
      disposed = true;
      usePrompts.getState().dropForTab(tab.id);
      if (id !== null) void api.close(id);
    };
    // `navigate` is stable enough for the first listing; reconnecting is driven by `attempt`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.hostId, attempt]);

  const runTransfer = useCallback(
    async (direction: "up" | "down", label: string, run: (id: number, onProgress: (p: TransferProgress) => void) => Promise<void>) => {
      const transferId = nextTransferId++;
      const update = (changes: Partial<Transfer>) =>
        setTransfers((all) => all.map((tr) => (tr.id === transferId ? { ...tr, ...changes } : tr)));
      setTransfers((all) => [...all, { id: transferId, direction, label, progress: null, state: "running" }]);
      try {
        await run(transferId, (progress) => update({ progress }));
        update({ state: "done" });
        setTimeout(() => setTransfers((all) => all.filter((tr) => tr.id !== transferId)), 4000);
      } catch (e) {
        const message = String(e);
        update(message.includes("cancelled") ? { state: "cancelled" } : { state: "failed", error: message });
      }
    },
    [],
  );

  // The panes refresh when a transfer into the folder they show ends.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const localCwdRef = useRef(localCwd);
  localCwdRef.current = localCwd;

  const upload = useCallback(
    async (paths: string[], target = cwdRef.current) => {
      if (sessionId === null || paths.length === 0) return;
      const label = paths.length === 1 ? paths[0].split(/[\\/]/).pop()! : t("sftp.items", { count: paths.length });
      await runTransfer("up", label, (transferId, onProgress) => api.upload(sessionId, transferId, paths, target, onProgress));
      if (target === cwdRef.current) void navigate(target);
    },
    [sessionId, runTransfer, navigate, t, api],
  );

  const downloadTo = useCallback(
    async (items: SftpEntry[], dir: string) => {
      if (sessionId === null) return;
      await Promise.all(items.map((item) => runTransfer("down", item.name, (transferId, onProgress) => api.download(sessionId, transferId, item, dir, onProgress))));
      if (dir === localCwdRef.current) void navigateLocal(dir);
    },
    [sessionId, runTransfer, api, navigateLocal],
  );

  /** Downloads into the local pane's folder, or asks where when that pane is hidden. */
  const download = async (items: SftpEntry[]) => {
    if (items.length === 0) return;
    if (showLocal && localCwd) return downloadTo(items, localCwd);
    const dir = await open({ directory: true, defaultPath: await downloadDir(), title: t("sftp.chooseDestination") });
    if (typeof dir === "string") await downloadTo(items, dir);
  };

  const pickAndUpload = async (directory: boolean) => {
    const picked = await open({ multiple: true, directory });
    if (Array.isArray(picked)) void upload(picked);
    else if (typeof picked === "string") void upload([picked]);
  };

  // Files dropped from the OS onto the window go to the server folder shown.
  const activeRef = useRef(active);
  activeRef.current = active;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (!activeRef.current) return;
      if (event.payload.type === "enter" || event.payload.type === "over") setDragging(true);
      else if (event.payload.type === "leave") setDragging(false);
      else if (event.payload.type === "drop") {
        setDragging(false);
        void uploadRef.current(event.payload.paths);
      }
    });
    return () => void unlisten.then((stop) => stop());
  }, []);

  const status = tab.status;
  if (sessionId === null) {
    return (
      <div className="grid h-full place-items-center">
        <div className="max-w-md px-6 text-center">
          {connectError ? (
            <>
              <p className="text-sm font-medium text-fg">{t("sftp.connectFailed")}</p>
              <p className="mt-1 text-sm break-words text-red">{connectError}</p>
              {/* Files of a Windows server go over its OpenSSH server, which is often off. */}
              {windowsHost && <p className="mt-3 select-text text-left text-xs leading-relaxed text-fg-muted [overflow-wrap:anywhere]">{t("files.windowsSshHint")}</p>}
              <Button variant="primary" className="mt-4" onClick={() => setAttempt((n) => n + 1)}>
                <RefreshCw className="size-4" />
                {t("sftp.reconnect")}
              </Button>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <LoaderCircle className="size-4 animate-spin" />
              {t(`monitor.status.${status === "connected" ? "connecting" : status}`)}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {accent && <div className="h-0.5 shrink-0" style={{ background: accent.hex }} />}

      <div className="flex min-h-0 flex-1">
        {showLocal && (
          <FilePane
            side="local"
            title={t("files.thisComputer")}
            icon={<Laptop className="size-3.5" />}
            cwd={localCwd}
            entries={localEntries}
            loading={localLoading}
            error={localError}
            canGoUp={localParent !== null}
            onUp={() => localParent && void navigateLocal(localParent)}
            onHome={() => void navigateLocal(localHomeRef.current)}
            onNavigate={(path) => void navigateLocal(path)}
            onMkdir={async (name) => {
              await localMkdir(localCwd, name);
              await navigateLocal(localCwd);
            }}
            onRename={async (entry, name) => {
              await localRename(entry.path, name);
              await navigateLocal(localCwd);
            }}
            onDelete={async (items) => {
              for (const item of items) await localDelete(item.path);
              await navigateLocal(localCwd);
            }}
            onOpenFile={(entry) => void upload([entry.path])}
            transfer={{ label: t("files.uploadSelected"), icon: <ArrowRight className="size-3.5" />, run: (items) => void upload(items.map((i) => i.path)) }}
            onReceive={(drag: PaneDrag, dir) => void downloadTo(drag.entries, dir)}
            footer={<span className="truncate">{t("files.localHint")}</span>}
          />
        )}

        <div className={cn("flex min-w-0 flex-1", showLocal && "border-l border-border")}>
          <FilePane
            side="remote"
            title={hostName}
            icon={<Server className="size-3.5" />}
            cwd={cwd}
            entries={entries}
            loading={loading}
            error={listError}
            canGoUp={cwd !== "/"}
            onUp={() => void navigate(parentOf(cwd))}
            onHome={() => void navigate(home)}
            onNavigate={(path) => void navigate(path)}
            onMkdir={async (name) => {
              await api.mkdir(sessionId, joinPath(cwd, name));
              await navigate(cwd);
            }}
            onRename={async (entry, name) => {
              await api.rename(sessionId, entry.path, joinPath(parentOf(entry.path), name));
              await navigate(cwd);
            }}
            onDelete={async (items) => {
              for (const item of items) await api.remove(sessionId, item);
              await navigate(cwd);
            }}
            onOpenFile={(entry) => void download([entry])}
            transfer={{
              label: t("sftp.download"),
              icon: showLocal ? <ArrowLeft className="size-3.5" /> : <Download className="size-3.5" />,
              run: (items) => void download(items),
            }}
            onReceive={(drag: PaneDrag, dir) => void upload(drag.entries.map((e) => e.path), dir)}
            showOwner={!showLocal}
            toolbar={
              <>
                <ToolbarButton label={t("sftp.uploadFolder")} onClick={() => void pickAndUpload(true)}>
                  <FolderUp className="size-4" />
                </ToolbarButton>
                <ToolbarButton label={t("sftp.upload")} onClick={() => void pickAndUpload(false)}>
                  <Upload className="size-4" />
                </ToolbarButton>
                <div className="mx-0.5 h-5 w-px bg-border" />
                <ToolbarButton
                  label={showLocal ? t("files.hideLocal") : t("files.showLocal")}
                  onClick={() => useSettings.getState().update({ filesShowLocal: !showLocal })}
                >
                  <PanelLeft className={cn("size-4", showLocal && "text-accent")} />
                </ToolbarButton>
              </>
            }
            footer={<span className="truncate">{showLocal ? t("files.remoteHint") : t("sftp.dropHint")}</span>}
          />
        </div>
      </div>

      {transfers.length > 0 && <Transfers transfers={transfers} onCancel={(id) => void api.cancelTransfer(id)} onDismiss={(id) => setTransfers((all) => all.filter((tr) => tr.id !== id))} />}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-card border-2 border-dashed border-accent bg-accent/10">
          <p className="flex items-center gap-2 rounded-btn bg-card px-4 py-2 text-sm font-medium text-fg shadow-md">
            <Upload className="size-4 text-accent" />
            <Trans i18nKey="sftp.dropHere" values={{ path: cwd }} components={{ b: <span className="font-mono" /> }} />
          </p>
        </div>
      )}
    </div>
  );
}

function Transfers({ transfers, onCancel, onDismiss }: { transfers: Transfer[]; onCancel: (id: number) => void; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="max-h-40 shrink-0 overflow-y-auto border-t border-border bg-card px-3 py-2">
      {transfers.map((transfer) => {
        const p = transfer.progress;
        const percent = p && p.total > 0 ? (p.transferred / p.total) * 100 : transfer.state === "done" ? 100 : 0;
        const Icon = transfer.direction === "up" ? Upload : Download;
        return (
          <div key={transfer.id} className="flex items-center gap-3 py-1 text-xs">
            <Icon className="size-3.5 shrink-0 text-fg-muted" />
            <span className="w-48 truncate text-fg">{transfer.label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width]",
                  transfer.state === "failed" ? "bg-red" : transfer.state === "done" ? "bg-green" : "bg-accent",
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="w-44 truncate text-right tabular-nums text-fg-muted" title={transfer.error}>
              {transfer.state === "failed"
                ? transfer.error
                : transfer.state === "cancelled"
                  ? t("sftp.cancelled")
                  : p
                    ? `${formatBytes(p.transferred)} / ${formatBytes(p.total)} · ${p.filesDone}/${p.filesTotal}`
                    : t("sftp.preparing")}
            </span>
            {transfer.state === "running" ? (
              <button type="button" className="cursor-pointer rounded p-0.5 text-fg-muted hover:bg-muted hover:text-red" onClick={() => onCancel(transfer.id)} title={t("common.cancel")} aria-label={t("common.cancel")}>
                <X className="size-3.5" />
              </button>
            ) : (
              <button type="button" className="cursor-pointer rounded p-0.5 text-fg-muted hover:bg-muted" onClick={() => onDismiss(transfer.id)} title={t("common.close")} aria-label={t("common.close")}>
                <X className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
