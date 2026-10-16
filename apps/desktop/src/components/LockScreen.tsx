import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LockKeyhole } from "lucide-react";

import { deviceUnlock } from "../lib/ipc";
import { Logo } from "./Logo";
import { Button } from "./ui/Button";

/**
 * The app lock (Settings): covers the app until the owner confirms with Face ID, Touch ID or the
 * device password. It asks on its own when it appears; the button asks again after a cancel.
 */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const ask = useCallback(async () => {
    setAsking(true);
    setError(null);
    try {
      await deviceUnlock(t("lock.reason"));
      onUnlock();
    } catch (e) {
      setError(String(e) === "cancelled" ? null : String(e));
    } finally {
      setAsking(false);
    }
  }, [onUnlock, t]);
  useEffect(() => {
    void ask();
  }, [ask]);
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-background px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" role="dialog" aria-modal="true" aria-label={t("lock.title")}>
      <div className="flex max-w-xs flex-col items-center text-center">
        <Logo className="size-14" />
        <h1 className="mt-5 text-lg font-semibold text-fg">{t("lock.title")}</h1>
        <p className="mt-1 text-sm text-fg-secondary">{t("lock.hint")}</p>
        {error && <p className="mt-3 text-sm text-red">{error}</p>}
        <Button variant="primary" className="mt-6" disabled={asking} onClick={() => void ask()}>
          <LockKeyhole className="size-4" />
          {t("lock.unlock")}
        </Button>
      </div>
    </div>
  );
}
