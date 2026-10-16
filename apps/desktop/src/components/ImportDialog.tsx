import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ChevronRight, Folder, Import, KeyRound, LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { importApply, importDetect, importRead, type DetectedImport, type ImportFormat, type ImportPreview } from "../lib/ipc";
import { useHostealo } from "../store/hostealo";
import { useHosts } from "../store/hosts";
import { Logo } from "./Logo";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Form";
import { Modal } from "./ui/Modal";

interface Source {
  format: ImportFormat;
  label: string;
  /** File dialog filter; none for formats that are a plain file name (ssh config). */
  extensions?: string[];
  multiple?: boolean;
  directory?: boolean;
}

const SOURCES: Source[] = [
  { format: "mobaXterm", label: "MobaXterm", extensions: ["mxtsessions", "ini"] },
  { format: "royalTs", label: "Royal TS / TSX", extensions: ["rtsz", "rtsx", "rtsj"] },
  { format: "putty", label: "PuTTY", extensions: ["reg"] },
  { format: "fileZilla", label: "FileZilla", extensions: ["xml"] },
  { format: "sshConfig", label: "OpenSSH" },
  { format: "rdpFile", label: "", extensions: ["rdp"], multiple: true },
];

const FORMAT_LABEL: Record<ImportFormat, string> = {
  mobaXterm: "MobaXterm",
  royalTs: "Royal TS",
  putty: "PuTTY",
  fileZilla: "FileZilla",
  sshConfig: "OpenSSH",
  rdpFile: "RDP",
};

const PROTOCOL_LABEL = { ssh: "SSH", ftp: "FTP", ftps: "FTPS", rdp: "RDP" } as const;

/** Brings connections over from other programs: pick a source, review, import. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const load = useHosts((s) => s.load);
  const [detected, setDetected] = useState<DetectedImport[] | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void importDetect()
      .then(setDetected)
      .catch(() => setDetected([]));
  }, []);

  const label = (source: Source) => source.label || t("import.rdpLabel");

  const read = async (paths: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await importRead(paths);
      setPreview(result);
      // Connections already saved start unticked.
      setSelected(new Set(result.hosts.flatMap((host, i) => (host.duplicate ? [] : [i]))));
      setInto(FORMAT_LABEL[result.format]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (source: Source) => {
    const picked = await open({
      multiple: source.multiple ?? false,
      directory: source.directory ?? false,
      title: t("import.pickTitle", { name: label(source) }),
      filters: source.extensions ? [{ name: label(source), extensions: source.extensions }] : undefined,
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length) await read(paths);
  };

  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await importApply(preview.token, [...selected].sort((a, b) => a - b), into.trim() || null);
      await load();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  // Hosts grouped by their folder in the source program.
  const groups = useMemo(() => {
    const byFolder = new Map<string, number[]>();
    preview?.hosts.forEach((host, i) => {
      const key = host.folder ?? "";
      byFolder.set(key, [...(byFolder.get(key) ?? []), i]);
    });
    return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [preview]);

  const toggle = (indexes: number[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      indexes.forEach((i) => (on ? next.add(i) : next.delete(i)));
      return next;
    });

  if (preview) {
    const all = preview.hosts.map((_, i) => i);
    const duplicates = preview.hosts.filter((h) => h.duplicate).length;
    return (
      <Modal
        title={t("import.reviewTitle", { name: FORMAT_LABEL[preview.format] })}
        icon={<Import className="size-4" />}
        onClose={onClose}
        className="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setPreview(null)} disabled={busy}>
              <ArrowLeft className="size-3.5" />
              {t("import.back")}
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || selected.size === 0}>
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              {t("import.submit", { count: selected.size })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="truncate text-xs text-fg-muted" title={preview.source}>
            {preview.source} · {t("import.found", { count: preview.hosts.length })}
            {duplicates > 0 && ` · ${t("import.duplicates", { count: duplicates })}`}
          </p>

          {preview.hosts.length === 0 ? (
            <p className="rounded-card border border-border bg-deep px-4 py-6 text-center text-sm text-fg-muted">{t("import.empty")}</p>
          ) : (
            <div className="max-h-[45vh] overflow-y-auto rounded-card border border-border">
              <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-card px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={selected.size === all.length}
                  ref={(el) => {
                    if (el) el.indeterminate = selected.size > 0 && selected.size < all.length;
                  }}
                  onChange={(e) => toggle(all, e.target.checked)}
                  aria-label={t("import.selectAll")}
                />
                <span className="font-medium text-fg-secondary">{t("import.selected", { count: selected.size, total: all.length })}</span>
              </div>
              {groups.map(([folder, indexes]) => (
                <div key={folder}>
                  {folder && (
                    <label className="flex cursor-pointer items-center gap-3 bg-deep px-3 py-1.5 text-xs font-medium text-fg-secondary">
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        checked={indexes.every((i) => selected.has(i))}
                        onChange={(e) => toggle(indexes, e.target.checked)}
                      />
                      <Folder className="size-3.5 text-fg-muted" />
                      {folder.split("/").join(" / ")}
                    </label>
                  )}
                  {indexes.map((i) => {
                    const host = preview.hosts[i];
                    return (
                      <label
                        key={i}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[13px] hover:bg-muted/50",
                          folder && "pl-8",
                        )}
                      >
                        <input type="checkbox" className="accent-[var(--accent)]" checked={selected.has(i)} onChange={(e) => toggle([i], e.target.checked)} />
                        <span className="w-11 shrink-0 rounded-badge bg-muted px-1.5 py-0.5 text-center font-mono text-[10px] text-fg-secondary">
                          {PROTOCOL_LABEL[host.protocol]}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium text-fg">{host.name}</span>
                        <span className="min-w-0 max-w-[45%] truncate font-mono text-xs text-fg-muted">
                          {host.username ? `${host.username}@` : ""}
                          {host.hostname}
                          {host.port !== { ssh: 22, ftp: 21, ftps: 21, rdp: 3389 }[host.protocol] ? `:${host.port}` : ""}
                        </span>
                        {host.keyPath && <KeyRound className="size-3.5 shrink-0 text-fg-muted" aria-label={t("import.key")} />}
                        {host.hasPassword && <LockKeyhole className="size-3.5 shrink-0 text-fg-muted" aria-label={t("import.password")} />}
                        {host.duplicate && <span className="shrink-0 rounded-badge bg-amber/15 px-1.5 py-0.5 text-[10px] font-medium text-amber">{t("import.exists")}</span>}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          <Field label={t("import.into")} hint={t("import.intoHint")}>
            {(id) => <Input id={id} value={into} onChange={(e) => setInto(e.target.value)} placeholder={t("import.topLevel")} />}
          </Field>

          {preview.warnings.length > 0 && (
            <details className="rounded-card border border-border bg-deep px-3 py-2 text-xs text-fg-secondary">
              <summary className="flex cursor-pointer items-center gap-2 font-medium">
                <TriangleAlert className="size-3.5 text-amber" />
                {t("import.warnings", { count: preview.warnings.length })}
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {preview.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {error && <p className="text-sm text-red">{error}</p>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t("import.title")} icon={<Import className="size-4" />} onClose={onClose} className="max-w-lg">
      <div className="flex flex-col gap-5">
        <p className="text-sm leading-relaxed text-fg-secondary">{t("import.intro")}</p>

        <button
          type="button"
          onClick={() => {
            onClose();
            useHostealo.getState().setDialogOpen(true);
          }}
          className="flex cursor-pointer items-center gap-3 rounded-card border border-accent/40 bg-accent/5 px-4 py-3 text-left shadow-sm transition-colors hover:bg-accent/10"
        >
          <Logo className="size-9" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-fg">{t("hostealo.importTitle")}</span>
            <span className="block text-xs leading-snug text-fg-muted">{t("hostealo.importHint")}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-fg-muted" />
        </button>

        {detected === null ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <LoaderCircle className="size-3.5 animate-spin" />
            {t("import.searching")}
          </p>
        ) : (
          detected.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">{t("import.detected")}</span>
              {detected.map((found) => (
                <button
                  key={found.path}
                  type="button"
                  disabled={busy}
                  onClick={() => void read([found.path])}
                  className="flex cursor-pointer items-center gap-3 rounded-btn border border-border bg-card px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-muted disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-fg">{FORMAT_LABEL[found.format]}</span>
                    <span className="block truncate font-mono text-xs text-fg-muted">{found.path === "registry:putty" ? t("import.registry") : found.path}</span>
                  </span>
                  <span className="shrink-0 text-xs text-fg-secondary">{t("import.found", { count: found.count })}</span>
                  <ChevronRight className="size-4 shrink-0 text-fg-muted" />
                </button>
              ))}
            </div>
          )
        )}

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg">{t("import.fromFile")}</span>
          <div className="grid grid-cols-2 gap-2">
            {SOURCES.map((source) => (
              <button
                key={source.format}
                type="button"
                disabled={busy}
                onClick={() => void pick(source)}
                className="cursor-pointer rounded-btn border border-border bg-card px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-muted disabled:opacity-60"
              >
                <span className="block text-sm font-medium text-fg">{label(source)}</span>
                <span className="block text-xs leading-snug text-fg-muted">{t(`import.hints.${source.format}`)}</span>
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs leading-relaxed text-fg-muted">{t("import.passwordsNote")}</p>
        {busy && (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <LoaderCircle className="size-3.5 animate-spin" />
            {t("import.reading")}
          </p>
        )}
        {error && <p className="break-words text-sm text-red">{error}</p>}
      </div>
    </Modal>
  );
}
