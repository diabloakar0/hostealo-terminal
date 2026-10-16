import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleCheck, ExternalLink, LoaderCircle, LogOut, RefreshCw } from "lucide-react";

import { hostealoConnect, hostealoDisconnect } from "../lib/ipc";
import { useHostealo } from "../store/hostealo";
import { useSettings } from "../store/settings";
import { Logo } from "./Logo";
import { Button } from "./ui/Button";
import { Field, Input, Segmented } from "./ui/Form";
import { Modal } from "./ui/Modal";

/** The client area, where API keys are created (Account → API Keys). */
const CLIENT_AREA = "https://my.hostealo.es";

/** Connects the user's Hostealo account: its VPS and dedicated servers appear as hosts. */
export function HostealoDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { account, syncing, lastSync, lastSyncAt, error, setAccount, sync } = useHostealo();
  const syncMinutes = useSettings((s) => s.hostealoSyncMinutes);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setConnectError(null);
    try {
      setAccount(await hostealoConnect(key.trim()));
      setKey("");
      await sync();
    } catch (e) {
      setConnectError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await hostealoDisconnect();
    setAccount(null);
  };

  return (
    <Modal
      title={t("hostealo.title")}
      icon={<Logo className="size-4" />}
      onClose={onClose}
      className="max-w-lg"
      footer={
        account ? (
          <>
            <Button onClick={() => void disconnect()}>
              <LogOut className="size-3.5" />
              {t("hostealo.disconnect")}
            </Button>
            <Button variant="primary" onClick={() => void sync()} disabled={syncing}>
              {syncing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t("hostealo.syncNow")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={() => void connect()} disabled={busy || !key.trim()}>
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              {t("hostealo.connect")}
            </Button>
          </>
        )
      }
    >
      {account ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-card border border-border bg-deep px-4 py-3">
            <CircleCheck className="size-5 shrink-0 text-green" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">{t("hostealo.connectedAs", { name: account.name ?? account.email ?? "Hostealo" })}</p>
              {account.email && account.name && <p className="truncate text-xs text-fg-muted">{account.email}</p>}
            </div>
          </div>
          <p className="text-sm leading-relaxed text-fg-secondary">{t("hostealo.connectedBody")}</p>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-fg">{t("hostealo.autoSync")}</span>
            <Segmented
              value={String(syncMinutes)}
              onChange={(value) => useSettings.getState().update({ hostealoSyncMinutes: Number(value) })}
              options={[
                { value: "0", label: t("hostealo.autoSyncOff") },
                { value: "5", label: t("hostealo.everyMinutes", { count: 5 }) },
                { value: "15", label: t("hostealo.everyMinutes", { count: 15 }) },
                { value: "60", label: t("hostealo.everyHour") },
              ]}
            />
          </div>
          {lastSync && (
            <p className="text-sm text-fg-secondary">
              {lastSyncAt && <span className="text-fg-muted">{t("hostealo.lastSync", { time: new Date(lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })} </span>}
              {t("hostealo.syncResult", { added: lastSync.added, updated: lastSync.updated, total: lastSync.added + lastSync.updated + lastSync.unchanged })}
              {lastSync.pending > 0 && ` ${t("hostealo.pending", { count: lastSync.pending })}`}
            </p>
          )}
          {error && <p className="break-words text-sm text-red">{error}</p>}
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <p className="text-sm leading-relaxed text-fg-secondary">{t("hostealo.intro")}</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-secondary">
            <li>
              {t("hostealo.step1")}{" "}
              <button type="button" onClick={() => void openUrl(CLIENT_AREA)} className="inline-flex cursor-pointer items-center gap-1 font-medium text-accent hover:underline">
                {t("hostealo.openClientArea")}
                <ExternalLink className="size-3" />
              </button>
            </li>
            <li>{t("hostealo.step2")}</li>
          </ol>
          <Field label={t("hostealo.apiKey")} hint={t("hostealo.apiKeyHint")} error={connectError ?? undefined}>
            {(id) => <Input id={id} type="password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />}
          </Field>
        </form>
      )}
    </Modal>
  );
}
