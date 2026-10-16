import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardPaste, TextSelect } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { tap } from "../lib/haptics";
import { getTerminal } from "../lib/terminals";
import { TOUCH_KEYS, useTouchModifiers } from "../lib/touchKeys";
import { TerminalTextSheet } from "./TerminalTextSheet";

/**
 * A row of the keys an on-screen keyboard lacks, under the terminal on touch screens, with
 * Paste and Select (the terminal's text in a sheet where the finger selects as anywhere in iOS).
 * The buttons try not to take the focus, and hand it back to the terminal after every tap, so
 * the keyboard stays open and the next key reaches the session.
 */
export function TouchKeys({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const { ctrl, alt, toggle, disarm } = useTouchModifiers();
  const [selecting, setSelecting] = useState(false);
  const keep = (e: React.SyntheticEvent) => e.preventDefault();
  const send = (data: string) => {
    const terminal = getTerminal(tabId);
    // Ctrl and Alt apply to typed keys; a bar key just sends itself and clears them.
    disarm();
    tap();
    terminal?.send(data);
    terminal?.focus();
  };
  const toggleModifier = (key: "ctrl" | "alt") => {
    toggle(key);
    tap();
    getTerminal(tabId)?.focus();
  };
  const paste = async () => {
    tap();
    const terminal = getTerminal(tabId);
    try {
      const text = await navigator.clipboard.readText();
      if (text) terminal?.insert(text);
    } catch {
      // Paste refused (iOS asks first): nothing to do.
    }
    terminal?.focus();
  };

  const key = "flex h-8 min-w-10 touch:h-11 touch:min-w-11 shrink-0 items-center justify-center gap-1 rounded-btn-sm border border-border bg-card px-2 font-mono text-[13px] text-fg active:bg-muted";
  const armedClass = "border-accent bg-accent text-white active:bg-accent";
  return (
    <>
      <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-border px-2 py-1.5" role="toolbar" aria-label={t("terminal.keys")}>
        <button type="button" onPointerDown={keep} onMouseDown={keep} onClick={() => toggleModifier("ctrl")} aria-pressed={ctrl} className={cn(key, ctrl && armedClass)}>
          Ctrl
        </button>
        <button type="button" onPointerDown={keep} onMouseDown={keep} onClick={() => toggleModifier("alt")} aria-pressed={alt} className={cn(key, alt && armedClass)}>
          Alt
        </button>
        {TOUCH_KEYS.map(({ label, data, aria, name }) => (
          <button
            key={label}
            type="button"
            onPointerDown={keep}
            onMouseDown={keep}
            onClick={() => send(data)}
            aria-label={name ? t(`terminal.key.${name}`) : aria}
            className={key}
          >
            {name ? t(`terminal.key.${name}`) : label}
          </button>
        ))}
        <button type="button" onPointerDown={keep} onMouseDown={keep} onClick={() => void paste()} className={cn(key, "font-sans")}>
          <ClipboardPaste className="size-3.5" />
          {t("terminal.key.paste")}
        </button>
        <button
          type="button"
          onClick={() => {
            tap();
            setSelecting(true);
          }}
          className={cn(key, "font-sans")}
        >
          <TextSelect className="size-3.5" />
          {t("terminal.key.select")}
        </button>
      </div>
      {selecting && <TerminalTextSheet tabId={tabId} onClose={() => setSelecting(false)} />}
    </>
  );
}
