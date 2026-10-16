import { useTranslation } from "react-i18next";
import { cn } from "@hostealo/ui/cn";

import { getTerminal } from "../lib/terminals";
import { TOUCH_KEYS, useCtrl } from "../lib/touchKeys";

/**
 * A row of the keys an on-screen keyboard lacks, under the terminal on touch screens. The
 * buttons try not to take the focus, and hand it back to the terminal after every tap, so the
 * keyboard stays open and the next key reaches the session.
 */
export function TouchKeys({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const ctrl = useCtrl();
  const keep = (e: React.SyntheticEvent) => e.preventDefault();
  const send = (data: string) => {
    const terminal = getTerminal(tabId);
    // Ctrl applies to typed keys; a bar key just sends itself and clears it.
    ctrl.disarm();
    terminal?.send(data);
    terminal?.focus();
  };
  const toggleCtrl = () => {
    ctrl.toggle();
    getTerminal(tabId)?.focus();
  };
  const key = "flex h-8 min-w-10 shrink-0 items-center justify-center rounded-btn-sm border border-border bg-card px-2 font-mono text-[13px] text-fg active:bg-muted";
  return (
    <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-border px-2 py-1.5" role="toolbar" aria-label={t("terminal.keys")}>
      <button type="button" onPointerDown={keep} onMouseDown={keep} onClick={toggleCtrl} aria-pressed={ctrl.armed} className={cn(key, ctrl.armed && "border-accent bg-accent text-white active:bg-accent")}>
        Ctrl
      </button>
      {TOUCH_KEYS.map(({ label, data, aria }) => (
        <button key={label} type="button" onPointerDown={keep} onMouseDown={keep} onClick={() => send(data)} aria-label={aria} className={key}>
          {label}
        </button>
      ))}
    </div>
  );
}
