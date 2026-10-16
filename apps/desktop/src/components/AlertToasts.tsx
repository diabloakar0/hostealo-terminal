import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Unplug, X } from "lucide-react";

import { alertText } from "../lib/alertWatch";
import { useAlerts, type Alert } from "../store/alerts";
import { useTabs } from "../store/tabs";

/** How long an alert stays on screen. */
const TOAST_MS = 8000;

/** New alerts, bottom right, until dismissed or for a few seconds. */
export function AlertToasts() {
  const toasts = useAlerts((s) => s.toasts);
  const alerts = useAlerts((s) => s.alerts);
  const shown = toasts.map((id) => alerts.find((a) => a.id === id)).filter((a): a is Alert => Boolean(a));
  if (shown.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-12 z-[70] flex w-80 flex-col gap-2">
      {shown.slice(-3).map((alert) => (
        <Toast key={alert.id} alert={alert} />
      ))}
    </div>
  );
}

function Toast({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const dismiss = () => useAlerts.getState().dismissToast(alert.id);
  useEffect(() => {
    const timer = setTimeout(dismiss, TOAST_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div role="status" className="v2-menu pointer-events-auto flex items-start gap-3 rounded-card p-3 text-sm shadow-md">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-red/10 text-red">
        {alert.kind === "disconnected" ? <Unplug className="size-3.5" /> : <CircleAlert className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-fg">{alert.hostName}</p>
        <p className="text-fg-secondary">{alertText(alert)}</p>
        <button
          type="button"
          onClick={() => {
            useTabs.getState().openPage("status");
            dismiss();
          }}
          className="mt-1 cursor-pointer text-xs font-medium text-accent hover:underline"
        >
          {t("alerts.view")}
        </button>
      </div>
      <button type="button" onClick={dismiss} aria-label={t("common.close")} className="cursor-pointer text-fg-muted hover:text-fg">
        <X className="size-4" />
      </button>
    </div>
  );
}
