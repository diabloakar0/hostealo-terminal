import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowLeftRight, Camera, CircleCheck, FileLock2, Laptop, LoaderCircle, QrCode as QrIcon, ShieldCheck, Smartphone, Wifi } from "lucide-react";

import {
  localHome,
  MIN_BACKUP_PASSPHRASE,
  shareFiles,
  syncBrowse,
  syncCancel,
  syncConfirm,
  syncConnect,
  syncExport,
  syncImport,
  syncListen,
  type SyncEvent,
  type SyncSummary,
} from "../lib/ipc";
import { isIOS } from "../lib/format";
import { parseQrFrame } from "../lib/qrTransfer";
import { useHosts } from "../store/hosts";
import { useUi } from "../store/ui";
import { QrCode } from "./QrCode";
import { QrReceive } from "./QrReceive";
import { QrSend } from "./QrSend";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyButton";
import { Checkbox, Field, Input, Segmented } from "./ui/Form";
import { Modal } from "./ui/Modal";

interface Device {
  id: string;
  name: string;
  address: string;
}

type Stage =
  | { kind: "searching" }
  | { kind: "connecting"; name: string }
  | { kind: "code"; session: number; peer: string; code: string; verified: boolean }
  | { kind: "waiting" }
  | { kind: "syncing" }
  | { kind: "done"; summary: SyncSummary }
  | { kind: "exported"; hosts: number; secrets: number; path: string }
  | { kind: "error"; message: string };

type Mode = "device" | "qr" | "backup";
type BackupMode = "export" | "import";

/**
 * Syncs hosts with another of the user's devices, with nothing in between: on the same network
 * (found automatically, or paired with the QR code / link), in QR codes that carry the servers
 * themselves (devices on different networks), or through an encrypted backup file.
 *
 * An iPhone or iPad does not look for devices: iOS keeps apps from multicasting on the network
 * without a special permission from Apple. It scans the computer's QR code with the camera
 * instead, which opens the app with the pairing link (`syncLink`).
 */
export function SyncDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("device");
  const [stage, setStage] = useState<Stage>({ kind: "searching" });
  const [me, setMe] = useState<{ device: string; addresses: string[]; pairing: string } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [manual, setManual] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(false);
  /** A code of a QR transfer opened with the Camera app. */
  const [qrIncoming, setQrIncoming] = useState<string | null>(null);
  const sessions = useRef<number[]>([]);
  const meRef = useRef(me);
  meRef.current = me;

  // Backup
  const [backupMode, setBackupMode] = useState<BackupMode>("export");
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every session reports to the same screen: whichever device connects first leads to the code.
  const onEvent = (session: () => number | undefined) => (event: SyncEvent) => {
    switch (event.type) {
      case "listening":
        return setMe({ device: event.device, addresses: event.addresses, pairing: event.pairing });
      case "found":
        // Our own advertisement shows up too.
        if (meRef.current?.addresses.includes(event.address)) return;
        return setDevices((all) => [...all.filter((d) => d.id !== event.id), { id: event.id, name: event.name, address: event.address }]);
      case "lost":
        return setDevices((all) => all.filter((d) => d.id !== event.id));
      case "code":
        return setStage({ kind: "code", session: session() ?? -1, peer: event.peer, code: event.code, verified: event.verified });
      case "syncing":
        return setStage({ kind: "syncing" });
      case "done":
        void useHosts.getState().load();
        return setStage({ kind: "done", summary: event.summary });
      case "error":
        return setStage({ kind: "error", message: event.message });
    }
  };

  const stop = () => {
    sessions.current.forEach((id) => void syncCancel(id));
    sessions.current = [];
  };

  const start = () => {
    setStage({ kind: "searching" });
    setDevices([]);
    let listenId: number | undefined;
    void syncListen(onEvent(() => listenId)).then((id) => {
      listenId = id;
      sessions.current.push(id);
    });
    if (!isIOS) void syncBrowse(onEvent(() => undefined)).then((id) => sessions.current.push(id));
  };

  useEffect(() => {
    if (!useUi.getState().syncLink) start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opened from the QR code: straight to the device it names.
  const syncLink = useUi((s) => s.syncLink);
  useEffect(() => {
    if (!syncLink) return;
    useUi.getState().setSyncLink(null);
    stop();
    if (parseQrFrame(syncLink)) {
      setMode("qr");
      setStage({ kind: "searching" });
      setQrIncoming(syncLink);
      return;
    }
    setMode("device");
    connect(syncLink, t("sync.linkedDevice"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncLink]);

  const connect = (address: string, name: string) => {
    setStage({ kind: "connecting", name });
    let connectId: number | undefined;
    void syncConnect(address, onEvent(() => connectId))
      .then((id) => {
        connectId = id;
        sessions.current.push(id);
      })
      .catch((e) => setStage({ kind: "error", message: String(e) }));
  };

  const answer = (accepted: boolean) => {
    if (stage.kind !== "code") return;
    void syncConfirm(stage.session, accepted, includeSecrets);
    setStage(accepted ? { kind: "waiting" } : { kind: "error", message: t("sync.rejected") });
  };

  const restart = () => {
    stop();
    setPassphrase("");
    setRepeat("");
    if (mode === "device") start();
    else setStage({ kind: "searching" });
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setStage({ kind: "searching" });
    // Only visible on the network while the device tab is open.
    if (next !== "device") stop();
    else start();
  };

  const tooShort = passphrase.length < MIN_BACKUP_PASSPHRASE;
  const canExport = !tooShort && passphrase === repeat;
  const canImport = file !== null && passphrase.length > 0;

  const exportBackup = async () => {
    const date = new Date().toISOString().slice(0, 10);
    const name = `hostealo-terminal-${date}.hostealo`;
    // iOS's save dialog can only place a file that already exists: the backup goes to the app's
    // documents (in the Files app) and then to the share sheet (AirDrop, Files, Mail...).
    const path = isIOS ? `${await localHome()}/${name}` : await save({ defaultPath: name, filters: [{ name: t("sync.backup.fileType"), extensions: ["hostealo"] }] });
    if (!path) return;
    setBusy(true);
    try {
      const summary = await syncExport(path, passphrase, includeSecrets);
      setStage({ kind: "exported", ...summary, path });
      if (isIOS) void shareFiles([path]).catch(() => undefined);
    } catch (e) {
      setStage({ kind: "error", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async () => {
    // Any file on iOS, where a backup that arrived by AirDrop or Mail may not keep its type.
    const path = await open({ multiple: false, filters: isIOS ? undefined : [{ name: t("sync.backup.fileType"), extensions: ["hostealo"] }] });
    if (typeof path === "string") setFile(path);
  };

  const importBackup = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const summary = await syncImport(file, passphrase);
      void useHosts.getState().load();
      setStage({ kind: "done", summary });
    } catch (e) {
      setStage({ kind: "error", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const finished = stage.kind === "done" || stage.kind === "exported" || stage.kind === "error";

  const footer =
    stage.kind === "code" ? (
      <>
        <Button onClick={() => answer(false)}>{stage.verified ? t("common.cancel") : t("sync.mismatch")}</Button>
        <Button variant="primary" onClick={() => answer(true)}>
          {stage.verified ? t("sync.syncNow") : t("sync.match")}
        </Button>
      </>
    ) : finished ? (
      <>
        {stage.kind === "error" && <Button onClick={restart}>{t("sync.retry")}</Button>}
        <Button variant="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      </>
    ) : mode === "backup" && stage.kind === "searching" ? (
      <>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        {backupMode === "export" ? (
          <Button variant="primary" disabled={!canExport || busy} onClick={() => void exportBackup()}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {t("sync.backup.save")}
          </Button>
        ) : (
          <Button variant="primary" disabled={!canImport || busy} onClick={() => void importBackup()}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {t("sync.backup.import")}
          </Button>
        )}
      </>
    ) : (
      <Button onClick={onClose}>{t("common.cancel")}</Button>
    );

  return (
    <Modal title={t("sync.title")} icon={<ArrowLeftRight className="size-4" />} onClose={onClose} className="max-w-xl" footer={footer}>
      {stage.kind === "searching" && (
        <div className="flex flex-col gap-4">
          <Segmented
            value={mode}
            onChange={switchMode}
            options={[
              {
                value: "device",
                label: (
                  <>
                    <Smartphone className="size-3.5" />
                    {t("sync.modeDevice")}
                  </>
                ),
              },
              {
                value: "qr",
                label: (
                  <>
                    <QrIcon className="size-3.5" />
                    {t("sync.modeQr")}
                  </>
                ),
              },
              {
                value: "backup",
                label: (
                  <>
                    <FileLock2 className="size-3.5" />
                    {t("sync.modeBackup")}
                  </>
                ),
              },
            ]}
          />

          {mode === "device" ? (
            <>
              <p className="text-sm leading-relaxed text-fg-secondary">{t(isIOS ? "sync.introPhone" : "sync.intro")}</p>

              {isIOS ? (
                <>
                  <div className="flex gap-3 rounded-card border border-border bg-deep p-4">
                    <Camera className="mt-0.5 size-5 shrink-0 text-accent" />
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <p className="text-sm font-medium text-fg">{t("sync.scanTitle")}</p>
                      <p className="text-sm leading-relaxed text-fg-muted">{t("sync.scanSteps")}</p>
                    </div>
                  </div>

                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value = manual.trim();
                      if (value) connect(value, value.startsWith("hostealo-terminal://") ? t("sync.linkedDevice") : value);
                    }}
                  >
                    <span className="text-sm font-medium text-fg">{t("sync.manualPhone")}</span>
                    <div className="flex gap-2">
                      <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("sync.manualPlaceholder")} aria-label={t("sync.manualPhone")} className="font-mono" />
                      <Button type="submit" disabled={!manual.trim()}>
                        {t("sync.connect")}
                      </Button>
                    </div>
                  </form>

                  <div className="flex flex-col gap-2 rounded-card border border-border px-4 py-3">
                    <p className="text-xs leading-relaxed text-fg-muted">{t("sync.phoneLink")}</p>
                    {me ? (
                      <div>
                        <CopyButton text={me.pairing} label={t("sync.copyLink")} />
                      </div>
                    ) : (
                      <LoaderCircle className="size-4 animate-spin text-fg-muted" />
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex gap-4 rounded-card border border-border bg-deep p-4">
                    <div className="grid size-[132px] shrink-0 place-items-center overflow-hidden rounded-btn bg-white">
                      {me ? <QrCode text={me.pairing} className="size-full" /> : <LoaderCircle className="size-5 animate-spin text-[#0b1220]/40" />}
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
                        <QrIcon className="size-4 text-accent" />
                        {t("sync.qrTitle")}
                      </p>
                      <p className="text-xs leading-relaxed text-fg-muted">{t("sync.qrHint")}</p>
                      {me && (
                        <div className="mt-auto">
                          <CopyButton text={me.pairing} label={t("sync.copyLink")} />
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-fg-muted">
                    <Wifi className="size-3.5 shrink-0 text-accent" />
                    {me ? t("sync.visibleAs", { name: me.device }) : t("sync.starting")} · {t("sync.visibleHint")}
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium text-fg">
                      {t("sync.nearby")}
                      <LoaderCircle className="size-3.5 animate-spin text-fg-muted" />
                    </span>
                    {devices.length === 0 ? (
                      <p className="rounded-card border border-dashed border-border px-4 py-4 text-center text-sm text-fg-muted">{t("sync.none")}</p>
                    ) : (
                      devices.map((device) => (
                        <button
                          key={device.id}
                          type="button"
                          onClick={() => connect(device.address, device.name)}
                          className="flex cursor-pointer items-center gap-3 rounded-btn border border-border bg-card px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-muted"
                        >
                          <Laptop className="size-4 shrink-0 text-accent" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-fg">{device.name}</span>
                            <span className="block font-mono text-xs text-fg-muted">{device.address.split(",")[0]}</span>
                          </span>
                          <span className="text-xs font-medium text-accent">{t("sync.connect")}</span>
                        </button>
                      ))
                    )}
                  </div>

                  <details className="text-sm">
                    <summary className="cursor-pointer text-fg-muted hover:text-fg">{t("sync.manual")}</summary>
                    <form
                      className="mt-2 flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const value = manual.trim();
                        if (value) connect(value, value.startsWith("hostealo-terminal://") ? t("sync.linkedDevice") : value);
                      }}
                    >
                      <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("sync.manualPlaceholder")} className="font-mono" />
                      <Button type="submit" disabled={!manual.trim()}>
                        {t("sync.connect")}
                      </Button>
                    </form>
                  </details>
                </>
              )}

              <p className="flex gap-2 text-xs leading-relaxed text-fg-muted">
                <Wifi className="mt-0.5 size-3.5 shrink-0 text-amber" />
                {t("sync.networkHint")}
              </p>
            </>
          ) : mode === "qr" ? (
            isIOS ? (
              <QrReceive
                incoming={qrIncoming}
                onDone={(summary) => {
                  void useHosts.getState().load();
                  setStage({ kind: "done", summary });
                }}
              />
            ) : (
              <QrSend />
            )
          ) : (
            <>
              <p className="text-sm leading-relaxed text-fg-secondary">{t("sync.backup.intro")}</p>
              <div className="flex gap-2">
                {(["export", "import"] as const).map((value) => (
                  <label
                    key={value}
                    className={`flex flex-1 cursor-pointer items-center gap-2 rounded-btn border px-3 py-2 text-sm transition-colors ${
                      backupMode === value ? "border-accent bg-accent/10 text-fg" : "border-border text-fg-secondary hover:bg-muted"
                    }`}
                  >
                    <input
                      type="radio"
                      name="backup-mode"
                      className="sr-only"
                      checked={backupMode === value}
                      onChange={() => {
                        setBackupMode(value);
                        setPassphrase("");
                        setRepeat("");
                      }}
                    />
                    {t(`sync.backup.${value}Option`)}
                  </label>
                ))}
              </div>

              {backupMode === "export" ? (
                <>
                  <Field label={t("sync.backup.passphrase")} hint={t("sync.backup.passphraseHint", { count: MIN_BACKUP_PASSPHRASE })}>
                    {(id) => <Input id={id} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />}
                  </Field>
                  <Field label={t("sync.backup.repeat")} error={repeat && repeat !== passphrase ? t("sync.backup.mismatch") : undefined}>
                    {(id) => <Input id={id} type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />}
                  </Field>
                  <div className="rounded-card border border-border px-4 py-3">
                    <Checkbox checked={includeSecrets} onChange={setIncludeSecrets}>
                      <span className="font-medium text-fg">{t("sync.backup.includeSecrets")}</span>
                    </Checkbox>
                    <p className="mt-1 pl-6 text-xs leading-relaxed text-fg-muted">{t("sync.backup.includeSecretsHint")}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3 rounded-card border border-border bg-deep px-4 py-3">
                    <FileLock2 className="size-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary">{file ? decodeURIComponent(file.split("/").pop() ?? file) : t("sync.backup.noFile")}</span>
                    <Button size="sm" onClick={() => void chooseFile()}>
                      {t("sync.backup.choose")}
                    </Button>
                  </div>
                  <Field label={t("sync.backup.passphrase")} hint={t("sync.backup.importHint")}>
                    {(id) => <Input id={id} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />}
                  </Field>
                </>
              )}
            </>
          )}
        </div>
      )}

      {(stage.kind === "connecting" || stage.kind === "waiting" || stage.kind === "syncing") && (
        <p className="flex items-center gap-2 py-6 text-sm text-fg-secondary">
          <LoaderCircle className="size-4 animate-spin text-accent" />
          {stage.kind === "connecting" ? t("sync.connecting", { name: stage.name }) : stage.kind === "waiting" ? t("sync.waitingOther") : t("sync.syncing")}
        </p>
      )}

      {stage.kind === "code" && (
        <div className="flex flex-col items-center gap-4 text-center">
          {stage.verified ? (
            <>
              <span className="grid size-14 place-items-center rounded-full bg-green/10 text-green">
                <ShieldCheck className="size-7" />
              </span>
              <p className="text-sm text-fg-secondary">{t("sync.paired", { name: stage.peer })}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-fg-secondary">{t("sync.compare", { name: stage.peer })}</p>
              <p className="rounded-card border border-border bg-deep px-8 py-4 font-mono text-4xl font-semibold tracking-[0.2em] text-fg">{stage.code}</p>
              <p className="flex items-center gap-1.5 text-xs text-fg-muted">
                <ShieldCheck className="size-3.5 text-green" />
                {t("sync.why")}
              </p>
            </>
          )}
          <div className="w-full rounded-card border border-border px-4 py-3 text-left">
            <Checkbox checked={includeSecrets} onChange={setIncludeSecrets}>
              <span className="font-medium text-fg">{t("sync.includeSecrets")}</span>
            </Checkbox>
            <p className="mt-1 pl-6 text-xs leading-relaxed text-fg-muted">{t("sync.includeSecretsHint")}</p>
          </div>
        </div>
      )}

      {stage.kind === "done" && (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CircleCheck className="size-10 text-green" />
          <p className="text-sm font-medium text-fg">{t("sync.done")}</p>
          <p className="text-sm text-fg-secondary">
            {t("sync.summary", { added: stage.summary.added, updated: stage.summary.updated, deleted: stage.summary.deleted })}
            {stage.summary.secrets > 0 && ` ${t("sync.secrets", { count: stage.summary.secrets })}`}
          </p>
        </div>
      )}

      {stage.kind === "exported" && (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CircleCheck className="size-10 text-green" />
          <p className="text-sm font-medium text-fg">{t("sync.backup.saved")}</p>
          <p className="text-sm text-fg-secondary">
            {t("sync.backup.savedSummary", { count: stage.hosts })}
            {stage.secrets > 0 && ` ${t("sync.backup.savedSecrets", { count: stage.secrets })}`}
          </p>
          <p className="max-w-full truncate font-mono text-xs text-fg-muted">{stage.path}</p>
          <p className="text-xs text-fg-muted">{t("sync.backup.keepPassphrase")}</p>
        </div>
      )}

      {stage.kind === "error" && <p className="break-words py-2 text-sm text-red">{stage.message}</p>}
    </Modal>
  );
}
