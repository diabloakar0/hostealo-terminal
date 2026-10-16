import { useEffect, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@hostealo/ui/cn";

import type { RdpInput } from "../lib/ipc";
import { namedKey, RDP_KEYS, typedText, useRdpKeyboard, withModifiers, type Modifier } from "../lib/rdpTouch";
import { CTRL_ALT_DEL } from "../lib/scancodes";

/** Keys the device keyboard reports by name rather than as text. */
const NAMED = new Set(["Backspace", "Enter", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/**
 * The device's keyboard for a remote desktop on a touch screen: a hidden field takes the typing,
 * and while it has the focus a row above the keyboard has the keys a phone keyboard lacks (Ctrl,
 * Alt and Windows stay armed for the next key).
 *
 * The field is always there, because iOS only shows its keyboard when a field gets the focus
 * during the tap itself: the tab bar's keyboard button focuses `field` right in its click
 * (RdpView's handle), which a field created after the tap could not get.
 */
export function RdpKeyboard({ field, open, send, onClose }: { field: RefObject<HTMLTextAreaElement | null>; open: boolean; send: (ops: RdpInput[]) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const armed = useRdpKeyboard((s) => s.armed);
  const toggle = useRdpKeyboard((s) => s.toggle);

  /** Sends a key with the armed modifiers, then clears them (as a sticky key does). */
  const press = (ops: RdpInput[] | null) => {
    if (!ops) return;
    const state = useRdpKeyboard.getState();
    send(withModifiers(ops, state.armed));
    state.disarm();
  };
  const type = (text: string) => {
    const state = useRdpKeyboard.getState();
    send(typedText(text, state.armed));
    state.disarm();
  };

  // The field stays empty: every keystroke is sent and its default action cancelled.
  const onBeforeInput = (e: InputEvent) => {
    e.preventDefault();
    if (e.inputType === "insertText" || e.inputType === "insertReplacementText" || e.inputType === "insertFromPaste") {
      if (e.data) type(e.data);
    } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
      press(namedKey("Enter"));
    } else if (e.inputType === "deleteContentBackward") {
      press(namedKey("Backspace"));
    } else if (e.inputType === "deleteContentForward") {
      press(namedKey("Delete"));
    }
  };

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const listener = (e: Event) => onBeforeInput(e as InputEvent);
    element.addEventListener("beforeinput", listener);
    return () => element.removeEventListener("beforeinput", listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Named keys (and anything typed on a hardware keyboard with a modifier) as keystrokes;
    // plain text comes through beforeinput.
    if (NAMED.has(e.key)) {
      e.preventDefault();
      press(namedKey(e.key));
    } else if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1) {
      e.preventDefault();
      const state = useRdpKeyboard.getState();
      send(typedText(e.key, { ctrl: state.armed.ctrl || e.ctrlKey || e.metaKey, alt: state.armed.alt || e.altKey, win: state.armed.win }));
      state.disarm();
    }
  };

  const keep = (e: React.SyntheticEvent) => e.preventDefault();
  const key = "flex h-8 min-w-10 touch:h-11 touch:min-w-11 shrink-0 items-center justify-center rounded-btn-sm border border-white/15 bg-white/10 px-2 font-mono text-[13px] text-white active:bg-white/25";
  const modifiers: { id: Modifier; label: string }[] = [
    { id: "ctrl", label: "Ctrl" },
    { id: "alt", label: "Alt" },
    { id: "win", label: "⊞ Win" },
  ];
  return (
    <>
      <textarea
        ref={field}
        aria-label={t("rdp.keyboard")}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          // A tap on the row keeps the keyboard; a tap elsewhere (the desktop) closes it.
          if (!e.relatedTarget) onClose();
        }}
        // On screen (iOS will not raise its keyboard for a field it cannot see) but invisible;
        // 16px so iOS does not zoom into it.
        className="pointer-events-none absolute bottom-0 left-0 size-px resize-none border-0 bg-transparent p-0 text-[16px] text-transparent caret-transparent opacity-[0.01] outline-none"
      />
      {open && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-white/10 bg-[#14161c] px-2 py-1.5" role="toolbar" aria-label={t("rdp.keyboard")}>
          {modifiers.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onPointerDown={keep}
              onMouseDown={keep}
              onClick={() => {
                toggle(id);
                field.current?.focus();
              }}
              aria-pressed={armed[id]}
              className={cn(key, armed[id] && "border-accent bg-accent active:bg-accent")}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onPointerDown={keep}
            onMouseDown={keep}
            onClick={() => {
              send([
                ...CTRL_ALT_DEL.map((scancode) => ({ type: "key" as const, scancode, pressed: true })),
                ...CTRL_ALT_DEL.slice().reverse().map((scancode) => ({ type: "key" as const, scancode, pressed: false })),
              ]);
              field.current?.focus();
            }}
            title={t("rdp.ctrlAltDel")}
            className={key}
          >
            {t("rdp.ctrlAltDelLabel")}
          </button>
          {RDP_KEYS.map(({ label, code }) => (
            <button
              key={code}
              type="button"
              onPointerDown={keep}
              onMouseDown={keep}
              onClick={() => {
                press(namedKey(code));
                field.current?.focus();
              }}
              className={key}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
