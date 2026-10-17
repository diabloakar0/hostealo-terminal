import { useTranslation } from "react-i18next";
import { ArrowDownToLine, LoaderCircle, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useUpdates } from "../lib/updates";
import { RELEASES_URL } from "../lib/version";
import { Button } from "./ui/Button";

/**
 * A new version, at the bottom of the sidebar: update in one click (download, install,
 * restart), or later. Also where a failed install sends to the download page (Linux .deb and
 * .rpm, for instance, cannot replace themselves).
 */
export function UpdateNotice() {
  const { t } = useTranslation();
  const status = useUpdates((s) => s.status);
  const dismissed = useUpdates((s) => s.dismissed);

  if (status.kind === "available" && status.version === dismissed) return null;
  if (status.kind !== "available" && status.kind !== "downloading" && status.kind !== "restart") {
    // An install that failed (a check that failed stays quiet: Settings shows it).
    if (status.kind !== "error" || !useUpdates.getState().update) return null;
  }

  const percent = status.kind === "downloading" && status.total ? Math.min(100, Math.round((status.done / status.total) * 100)) : null;
  return (
    <div className="mx-2 mb-2 flex flex-col gap-2 rounded-card border border-accent/40 bg-accent/10 px-3 py-2.5" role="status">
      {status.kind === "available" && (
        <>
          <div className="flex items-start gap-2">
            <ArrowDownToLine className="mt-0.5 size-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 text-sm font-medium text-fg">{t("updates.available", { version: status.version })}</span>
            <button
              type="button"
              onClick={() => useUpdates.getState().dismiss()}
              aria-label={t("updates.later")}
              title={t("updates.later")}
              className="-mr-1 cursor-pointer rounded p-0.5 text-fg-muted hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <Button size="sm" variant="primary" onClick={() => void useUpdates.getState().install()}>
            {t("updates.install")}
          </Button>
        </>
      )}
      {status.kind === "downloading" && (
        <>
          <span className="flex items-center gap-2 text-sm text-fg">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent" />
            {t("updates.downloading", { version: status.version })}
          </span>
          <div className="h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <div className={percent === null ? "h-full w-1/3 animate-pulse rounded-full bg-accent" : "h-full rounded-full bg-accent transition-[width]"} style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
        </>
      )}
      {status.kind === "restart" && (
        <span className="flex items-center gap-2 text-sm text-fg">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent" />
          {t("updates.restart")}
        </span>
      )}
      {status.kind === "error" && (
        <>
          <span className="text-sm text-fg">{t("updates.failed")}</span>
          <Button size="sm" onClick={() => void openUrl(RELEASES_URL)}>
            {t("updates.download")}
          </Button>
        </>
      )}
    </div>
  );
}
