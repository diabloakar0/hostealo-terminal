import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Camera, LoaderCircle, ScanQrCode } from "lucide-react";

import { tap } from "../lib/haptics";
import { syncQrImport, type SyncSummary } from "../lib/ipc";
import { collectQrFrame, qrComplete, type QrCollection } from "../lib/qrTransfer";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Form";

/**
 * The phone's side of a transfer by QR code: the camera reads the codes the computer shows, in
 * whatever order they come, until it has them all (`incoming` also brings the ones opened with
 * the Camera app).
 *
 * The scanner's camera sits behind the page (its "windowed" mode, the page made transparent
 * with `data-scanning`), so this draws its own frame, progress and Cancel over it. It stops
 * after each code, so the loop asks for the next one.
 */
export function QrReceive({ incoming, onDone }: { incoming: string | null; onDone: (summary: SyncSummary) => void }) {
  const { t } = useTranslation();
  const [collection, setCollection] = useState<QrCollection | null>(null);
  const [scanning, setScanning] = useState(false);
  const [denied, setDenied] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(collection);
  current.current = collection;
  const stopped = useRef(false);
  const submitted = useRef<string | null>(null);

  useEffect(() => {
    if (incoming) setCollection((c) => collectQrFrame(c, incoming));
  }, [incoming]);

  const finish = async (complete: QrCollection, typed: string | null) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await syncQrImport([...complete.parts.values()], typed));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Without passwords nothing has to be typed: in as soon as every code is read.
  useEffect(() => {
    if (!qrComplete(collection) || collection.needsCode || scanning || submitted.current === collection.transfer) return;
    submitted.current = collection.transfer;
    void finish(collection, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, scanning]);

  const stopScanning = () => {
    stopped.current = true;
    void import("@tauri-apps/plugin-barcode-scanner").then((scanner) => scanner.cancel()).catch(() => {});
  };

  // Closing the window while the camera is on turns it off.
  useEffect(
    () => () => {
      if (document.documentElement.dataset.scanning === undefined) return;
      stopScanning();
      delete document.documentElement.dataset.scanning;
    },
    [],
  );

  const scanCodes = async () => {
    setError(null);
    try {
      const scanner = await import("@tauri-apps/plugin-barcode-scanner");
      let permission = await scanner.checkPermissions();
      if (permission !== "granted") permission = await scanner.requestPermissions();
      if (permission !== "granted") return setDenied(true);
      setDenied(false);
      stopped.current = false;
      setScanning(true);
      document.documentElement.dataset.scanning = "";
      let read = current.current;
      while (!stopped.current && !qrComplete(read)) {
        const { content } = await scanner.scan({ windowed: true, formats: [scanner.Format.QRCode] });
        const next = collectQrFrame(read, content);
        if (next !== read) {
          tap();
          read = next;
          setCollection(next);
        }
      }
    } catch (e) {
      if (!stopped.current && !String(e).includes("cancel")) setError(String(e));
    } finally {
      delete document.documentElement.dataset.scanning;
      setScanning(false);
    }
  };

  const read = collection?.parts.size ?? 0;
  const total = collection?.total ?? 0;
  const progress = total > 1 && (
    <div className="flex w-full flex-col gap-1.5">
      <span className="text-sm">{t("sync.qr.progress", { read, total })}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/25" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={read}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(read / total) * 100}%` }} />
      </div>
    </div>
  );

  return (
    <>
      <p className="text-sm leading-relaxed text-fg-secondary">{t("sync.qr.receiveIntro")}</p>

      {qrComplete(collection) && collection.needsCode ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) void finish(collection, code);
          }}
        >
          <Field label={t("sync.qr.codeLabel")} hint={t("sync.qr.codeHint")}>
            {(id) => (
              <Input
                id={id}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="K7QM-2XPA"
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="one-time-code"
                spellCheck={false}
                className="font-mono tracking-widest"
                autoFocus
              />
            )}
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={!code.trim() || busy}>
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              {busy ? t("sync.qr.importing") : t("sync.qr.import")}
            </Button>
          </div>
        </form>
      ) : busy ? (
        <p className="flex items-center gap-2 py-2 text-sm text-fg-secondary">
          <LoaderCircle className="size-4 animate-spin text-accent" />
          {t("sync.qr.importing")}
        </p>
      ) : (
        <>
          {total > 1 && <p className="text-sm text-fg-secondary">{t("sync.qr.progress", { read, total })}</p>}
          <Button variant="primary" className="w-full" onClick={() => void scanCodes()}>
            <ScanQrCode className="size-4" />
            {read > 0 ? t("sync.qr.scanMore") : t("sync.qr.scan")}
          </Button>
          <p className="flex gap-2 text-xs leading-relaxed text-fg-muted">
            <Camera className="mt-0.5 size-3.5 shrink-0 text-accent" />
            {t("sync.qr.cameraHint")}
          </p>
        </>
      )}

      {denied && (
        <div className="flex items-center justify-between gap-3 rounded-card border border-border px-4 py-3 text-sm text-fg-secondary">
          {t("sync.qr.noCamera")}
          <Button size="sm" onClick={() => void import("@tauri-apps/plugin-barcode-scanner").then((scanner) => scanner.openAppSettings())}>
            {t("sync.qr.openSettings")}
          </Button>
        </div>
      )}
      {error && <p className="break-words text-sm text-red">{error}</p>}

      {scanning &&
        createPortal(
          <div className="qr-scanner fixed inset-0 z-[100] flex flex-col items-center justify-between px-6 pt-[calc(env(safe-area-inset-top)+24px)] pb-[calc(env(safe-area-inset-bottom)+24px)] text-white">
            <p className="rounded-full bg-black/65 px-4 py-2 text-center text-sm">{t("sync.qr.scanning")}</p>
            <div aria-hidden className="aspect-square w-[72vw] max-w-[360px] rounded-[28px] border-[3px] border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]" />
            <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-card bg-black/65 p-4">
              {progress}
              <Button className="w-full" onClick={stopScanning}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
