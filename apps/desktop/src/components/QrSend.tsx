import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, LoaderCircle, RotateCcw, Smartphone } from "lucide-react";

import { syncQrExport, type QrExport } from "../lib/ipc";
import { formatTransferCode } from "../lib/qrTransfer";
import { QrCode } from "./QrCode";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Form";

/** How long each code of a transfer stays on screen when there are several. */
const FRAME_MS = 700;

/**
 * The computer's side of a transfer by QR code: the servers in the codes themselves, shown in
 * turn when they take several, for a phone that cannot reach this computer on a network.
 */
export function QrSend() {
  const { t } = useTranslation();
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [transfer, setTransfer] = useState<QrExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);

  const total = transfer?.frames.length ?? 0;
  useEffect(() => {
    if (total < 2) return;
    const timer = window.setInterval(() => setFrame((f) => (f + 1) % total), FRAME_MS);
    return () => window.clearInterval(timer);
  }, [total]);

  const show = async () => {
    setBusy(true);
    setError(null);
    try {
      setFrame(0);
      setTransfer(await syncQrExport(includeSecrets));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!transfer) {
    return (
      <>
        <p className="text-sm leading-relaxed text-fg-secondary">{t("sync.qr.intro")}</p>
        <div className="rounded-card border border-border px-4 py-3">
          <Checkbox checked={includeSecrets} onChange={setIncludeSecrets}>
            <span className="font-medium text-fg">{t("sync.qr.includeSecrets")}</span>
          </Checkbox>
          <p className="mt-1 pl-6 text-xs leading-relaxed text-fg-muted">{t("sync.qr.includeSecretsHint")}</p>
        </div>
        {error && <p className="break-words text-sm text-red">{error}</p>}
        <div>
          <Button variant="primary" disabled={busy} onClick={() => void show()}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {t("sync.qr.show")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="w-full max-w-[340px] overflow-hidden rounded-card bg-white p-1">
        <QrCode text={transfer.frames[frame]} ecc="L" className="block size-full" label={t("sync.modeQr")} />
      </div>
      <p className="text-xs text-fg-muted" aria-live="off">
        {t("sync.qr.summary", { count: transfer.hosts })}
        {transfer.secrets > 0 && t("sync.qr.secrets", { count: transfer.secrets })}
        {total > 1 && ` · ${t("sync.qr.part", { index: frame + 1, total })}`}
      </p>
      {transfer.code && (
        <div className="flex w-full flex-col items-center gap-1 rounded-card border border-border bg-deep px-4 py-3">
          <span className="flex items-center gap-1.5 text-xs text-fg-muted">
            <KeyRound className="size-3.5 text-accent" />
            {t("sync.qr.code")}
          </span>
          <span className="font-mono text-2xl font-semibold tracking-[0.15em] text-fg">{formatTransferCode(transfer.code)}</span>
        </div>
      )}
      <p className="flex gap-2 text-sm leading-relaxed text-fg-secondary">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-accent" />
        {t("sync.qr.steps")}
      </p>
      <Button size="sm" onClick={() => setTransfer(null)}>
        <RotateCcw className="size-3.5" />
        {t("sync.qr.again")}
      </Button>
    </div>
  );
}
