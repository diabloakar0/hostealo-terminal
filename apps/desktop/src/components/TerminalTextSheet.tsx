import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, X } from "lucide-react";

import { getTerminal } from "../lib/terminals";
import { Button } from "./ui/Button";

/** How much of the terminal's history the sheet shows. */
const LINES = 2000;

/**
 * The terminal's text as plain text in a sheet, where the finger selects it as anywhere in iOS
 * (selecting inside the terminal itself is not possible with a finger), with Copy all.
 */
export function TerminalTextSheet({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [text] = useState(() => getTerminal(tabId)?.recentOutput(LINES) ?? "");
  const [copied, setCopied] = useState(false);
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-card pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" role="dialog" aria-modal="true" aria-label={t("terminal.key.selectTitle")}>
      <header className="flex h-13 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{t("terminal.key.selectTitle")}</span>
        <Button size="sm" onClick={() => void copyAll()}>
          {copied ? <Check className="size-3.5 text-green" /> : <Copy className="size-3.5" />}
          {copied ? t("terminal.key.copied") : t("terminal.key.copyAll")}
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("common.close")}>
          <X className="size-4" />
        </Button>
      </header>
      <p className="shrink-0 px-3 pt-2 text-xs text-fg-muted">{t("terminal.key.selectHint")}</p>
      {/* Selectable, unlike the rest of the app chrome. */}
      <pre data-own-touch className="min-h-0 flex-1 select-text overflow-auto px-3 py-2 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-fg [-webkit-touch-callout:default] [-webkit-user-select:text]">
        {text}
      </pre>
    </div>
  );
}
