import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { downloadDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CircleAlert, CircleCheck, Files, FolderOpen, LoaderCircle, X } from "lucide-react";

import { formatBytes, isMac } from "../lib/format";
import { rdpClipboardCancel, rdpClipboardSave, type RdpClipboardNotice } from "../lib/ipc";
import { Button } from "./ui/Button";

/** How long the "saved" confirmation stays up. */
const SAVED_VISIBLE_MS = 8000;

interface Props {
  session: number | null;
  /** The latest clipboard notice, or null when there is nothing to show. */
  notice: RdpClipboardNotice | null;
  onDismiss: () => void;
}

/**
 * Files copied on the remote desktop can't be pasted straight into Finder: this bar offers to
 * save them, shows the progress and where they ended up.
 */
export function RdpClipboardBar({ session, notice, onDismiss }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    if (notice?.kind !== "saved" && notice?.kind !== "cancelled") return;
    const timer = setTimeout(onDismiss, notice.kind === "saved" ? SAVED_VISIBLE_MS : 0);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice || session === null || notice.kind === "cancelled") return null;
  if (notice.kind === "remoteFiles" && notice.count === 0) return null;

  const saveTo = async () => {
    const dir = await open({ directory: true, defaultPath: await downloadDir(), title: t("rdp.clipboard.chooseFolder") });
    if (typeof dir === "string") void rdpClipboardSave(session, dir);
  };

  let icon = <Files className="size-4 shrink-0 text-accent" />;
  let body: ReactNode;
  let actions: ReactNode = null;
  switch (notice.kind) {
    case "remoteFiles": {
      const names = notice.names.slice(0, 3).join(", ") + (notice.names.length > 3 ? ", …" : "");
      body = (
        <>
          <p className="font-medium text-fg">{t("rdp.clipboard.remoteFiles", { count: notice.count })}</p>
          <p className="truncate text-xs text-fg-muted" title={notice.names.join("\n")}>
            {names}
            {notice.bytes > 0 && ` · ${formatBytes(notice.bytes)}`}
          </p>
        </>
      );
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={() => void rdpClipboardSave(session)}>
            {t("rdp.clipboard.saveToDownloads")}
          </Button>
          <Button size="sm" onClick={() => void saveTo()}>
            {t("rdp.clipboard.saveTo")}
          </Button>
        </>
      );
      break;
    }
    case "progress": {
      const percent = notice.total > 0 ? Math.min(100, (notice.done / notice.total) * 100) : 0;
      icon = <LoaderCircle className="size-4 shrink-0 animate-spin text-accent" />;
      body = (
        <>
          <p className="font-medium text-fg">{t("rdp.clipboard.saving")}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
            </div>
            <span className="text-xs tabular-nums text-fg-muted">
              {formatBytes(notice.done)} / {formatBytes(notice.total)}
            </span>
          </div>
        </>
      );
      actions = (
        <Button size="sm" onClick={() => void rdpClipboardCancel(session)}>
          {t("common.cancel")}
        </Button>
      );
      break;
    }
    case "saved":
      icon = <CircleCheck className="size-4 shrink-0 text-green" />;
      body = (
        <>
          <p className="font-medium text-fg">{t("rdp.clipboard.saved")}</p>
          <p className="truncate text-xs text-fg-muted">{notice.paths[0]}</p>
        </>
      );
      actions = notice.paths.length > 0 && (
        <Button size="sm" onClick={() => void revealItemInDir(notice.paths[0])}>
          <FolderOpen className="size-3.5" />
          {t(isMac ? "rdp.clipboard.showInFinder" : "rdp.clipboard.showInFolder")}
        </Button>
      );
      break;
    case "failed":
      icon = <CircleAlert className="size-4 shrink-0 text-red" />;
      body = (
        <>
          <p className="font-medium text-fg">{t("rdp.clipboard.saveFailed")}</p>
          <p className="break-words text-xs text-red">{notice.error}</p>
        </>
      );
      break;
  }

  return (
    <div
      role="status"
      className="absolute inset-x-0 bottom-4 z-10 mx-auto flex w-[min(40rem,calc(100%-2rem))] items-center gap-3 rounded-card border border-border bg-card px-4 py-3 text-sm shadow-lg"
    >
      {icon}
      <div className="min-w-0 flex-1">{body}</div>
      {actions}
      {notice.kind !== "progress" && (
        <button
          type="button"
          className="cursor-pointer rounded p-1 text-fg-muted hover:bg-muted hover:text-fg"
          onClick={onDismiss}
          title={t("rdp.clipboard.dismiss")}
          aria-label={t("rdp.clipboard.dismiss")}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
