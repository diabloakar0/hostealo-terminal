import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Pencil, Play, Plus, Search, ShieldAlert, Trash2, Zap } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { isDangerousCommand } from "../lib/danger";
import { isMac } from "../lib/format";
import type { Snippet } from "../lib/ipc";
import { getTerminal } from "../lib/terminals";
import { useHosts } from "../store/hosts";
import { isTerminalTab, useTabs } from "../store/tabs";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Form";
import { Modal } from "./ui/Modal";

/** Whether the quick commands panel is open (the tab bar button and ⌘P toggle it). */
export const useQuickCommands = create<{ open: boolean; setOpen: (open: boolean) => void; toggle: () => void }>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}));

/** A few common ones, offered while the list is empty. */
const EXAMPLES: Omit<Snippet, "id">[] = [
  { name: "Espacio en disco", command: "df -h" },
  { name: "Memoria", command: "free -h" },
  { name: "Lo que más consume", command: "ps aux --sort=-%cpu | head -15" },
  { name: "Logs del sistema en directo", command: "journalctl -f -n 50" },
  { name: "Contenedores", command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'" },
  { name: "Puertos a la escucha", command: "ss -tulpn" },
];

/** Multi-line commands run one line after the other, as if typed. */
const asTyped = (command: string) => command.replace(/\r?\n/g, "\r");

/** The "Commands" button in the tab bar, with its panel. */
export function QuickCommandsButton() {
  const { t } = useTranslation();
  const open = useQuickCommands((s) => s.open);
  const button = useRef<HTMLDivElement>(null);
  return (
    <div ref={button} className="flex">
      <Button
        size="sm"
        variant={open ? "secondary" : "ghost"}
        onClick={() => useQuickCommands.getState().toggle()}
        title={`${t("snippets.title")} (${isMac ? "⌘P" : "Ctrl+Shift+P"})`}
        aria-pressed={open}
      >
        <Zap className="size-3.5 text-accent" />
        <span className="compact:hidden">{t("snippets.short")}</span>
      </Button>
      {open && <QuickCommandsPanel anchor={button.current} onClose={() => useQuickCommands.getState().setOpen(false)} />}
    </div>
  );
}

function QuickCommandsPanel({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const { t } = useTranslation();
  const snippets = useHosts((s) => s.snippets);
  const activeId = useTabs((s) => s.activeId);
  const activeTab = useTabs((s) => s.tabs.find((tab) => tab.id === s.activeId));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [confirmRun, setConfirmRun] = useState<Snippet | null>(null);
  const [position, setPosition] = useState<{ right: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // While a dialog is open on top, clicks there must not close the panel.
  const dialogOpen = editing !== null || deleting !== null || confirmRun !== null;
  const dialogRef = useRef(dialogOpen);
  dialogRef.current = dialogOpen;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? snippets.filter((s) => s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q)) : snippets;
  }, [snippets, query]);
  const terminal = activeTab && isTerminalTab(activeTab) ? getTerminal(activeId) : undefined;

  useLayoutEffect(() => {
    const rect = anchor?.getBoundingClientRect();
    if (rect) setPosition({ right: Math.max(8, window.innerWidth - rect.right), top: rect.bottom + 6 });
  }, [anchor]);

  useEffect(() => {
    search.current?.focus();
    const onPointer = (e: MouseEvent) => {
      if (dialogRef.current) return;
      if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  useEffect(() => setSelected(0), [query]);

  /** Types the command at the prompt; with `run`, presses Enter too. */
  const use = (snippet: Snippet, run: boolean, confirmed = false) => {
    if (!terminal) return;
    if (run && !confirmed && isDangerousCommand(snippet.command)) return setConfirmRun(snippet);
    if (run) terminal.run(asTyped(snippet.command));
    else terminal.insert(snippet.command);
    onClose();
    terminal.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      terminal?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelected((i) => (matches.length ? (i + step + matches.length) % matches.length : 0));
    } else if (e.key === "Enter" && matches[selected]) {
      e.preventDefault();
      // Enter runs it; Shift+Enter only types it.
      use(matches[selected], !e.shiftKey);
    }
  };

  const addExamples = async () => {
    for (const example of EXAMPLES) await useHosts.getState().saveSnippet({ id: "", ...example });
  };

  return createPortal(
    <>
      <div
        ref={ref}
        role="dialog"
        aria-label={t("snippets.title")}
        onKeyDown={onKeyDown}
        style={position ?? { right: 8, top: -9999 }}
        className="v2-menu fixed z-[55] flex max-h-[min(480px,calc(100vh-80px))] w-[380px] flex-col overflow-hidden rounded-lg text-sm"
      >
        <div className="flex items-center gap-2 border-b border-border p-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-muted" />
            <Input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("snippets.search")} className="h-8 pl-8" />
          </div>
          <Button size="sm" onClick={() => setEditing({ id: "", name: "", command: "" })} title={t("snippets.new")}>
            <Plus className="size-3.5" />
            {t("snippets.newShort")}
          </Button>
        </div>

        {!terminal && <p className="border-b border-border bg-deep px-3 py-2 text-xs text-fg-muted">{t("snippets.noTerminal")}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {snippets.length === 0 ? (
            <div className="px-3 py-5 text-center">
              <Zap className="mx-auto size-6 text-accent" />
              <p className="mt-2 font-medium text-fg">{t("snippets.emptyTitle")}</p>
              <p className="mt-1 text-xs leading-relaxed text-fg-muted">{t("snippets.emptyHint")}</p>
              <div className="mt-3 flex justify-center gap-2">
                <Button size="sm" onClick={() => void addExamples()}>
                  {t("snippets.addExamples")}
                </Button>
                <Button size="sm" variant="primary" onClick={() => setEditing({ id: "", name: "", command: "" })}>
                  <Plus className="size-3.5" />
                  {t("snippets.new")}
                </Button>
              </div>
            </div>
          ) : matches.length === 0 ? (
            <p className="px-3 py-5 text-center text-xs text-fg-muted">{t("snippets.noMatches")}</p>
          ) : (
            matches.map((snippet, index) => (
              <div
                key={snippet.id}
                onMouseEnter={() => setSelected(index)}
                className={cn("group flex items-center gap-1 rounded-md pr-1", index === selected && "bg-muted")}
              >
                <button
                  type="button"
                  disabled={!terminal}
                  onClick={() => use(snippet, false)}
                  title={t("snippets.insertHint")}
                  className="min-w-0 flex-1 cursor-pointer px-2.5 py-1.5 text-left disabled:cursor-not-allowed"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-fg">{snippet.name}</span>
                    {isDangerousCommand(snippet.command) && <ShieldAlert className="size-3.5 shrink-0 text-amber" aria-label={t("snippets.dangerous")} />}
                  </span>
                  <span className="block truncate font-mono text-xs text-fg-muted">{snippet.command.replace(/\n/g, " ⏎ ")}</span>
                </button>
                <IconButton label={t("snippets.edit")} onClick={() => setEditing(snippet)} className="opacity-0 group-hover:opacity-100 touch:opacity-100">
                  <Pencil />
                </IconButton>
                <IconButton label={t("snippets.delete")} onClick={() => setDeleting(snippet)} className="opacity-0 hover:!text-red group-hover:opacity-100 touch:opacity-100">
                  <Trash2 />
                </IconButton>
                <IconButton label={t("snippets.run")} onClick={() => use(snippet, true)} disabled={!terminal} className="text-accent">
                  <Play />
                </IconButton>
              </div>
            ))
          )}
        </div>

        {snippets.length > 0 && (
          <p className="border-t border-border px-3 py-1.5 text-[11px] text-fg-muted">
            {t("snippets.keys")}
          </p>
        )}
      </div>

      {editing && <SnippetDialog snippet={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={t("snippets.deleteTitle")}
          confirmLabel={t("sidebar.delete")}
          onConfirm={() => useHosts.getState().removeSnippet(deleting.id)}
          onClose={() => setDeleting(null)}
        >
          {t("snippets.deleteBody", { name: deleting.name })}
        </ConfirmDialog>
      )}
      {confirmRun && (
        <ConfirmDialog
          title={t("snippets.dangerTitle")}
          confirmLabel={t("snippets.runAnyway")}
          icon={<ShieldAlert className="size-4" />}
          onConfirm={() => use(confirmRun, true, true)}
          onClose={() => setConfirmRun(null)}
        >
          <p>{t("snippets.dangerBody")}</p>
          <pre className="mt-2 overflow-x-auto rounded-btn border border-border bg-deep px-3 py-2 font-mono text-xs text-fg whitespace-pre-wrap [overflow-wrap:anywhere]">
            {confirmRun.command}
          </pre>
        </ConfirmDialog>
      )}
    </>,
    document.body,
  );
}

function IconButton({ label, onClick, disabled, className, children }: { label: string; onClick: () => void; disabled?: boolean; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors hover:bg-card hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 [&>svg]:size-3.5",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Creates or edits a quick command. */
function SnippetDialog({ snippet, onClose }: { snippet: Snippet; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(snippet.name);
  const [command, setCommand] = useState(snippet.command);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!command.trim()) return;
    setBusy(true);
    try {
      await useHosts.getState().saveSnippet({ ...snippet, name, command });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={snippet.id ? t("snippets.edit") : t("snippets.new")}
      icon={<Zap className="size-4" />}
      onClose={onClose}
      className="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !command.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t("snippets.name")} hint={t("snippets.nameHint")}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("snippets.namePlaceholder")} />}
        </Field>
        <Field label={t("snippets.command")} hint={t("snippets.commandHint")} error={error ?? undefined}>
          {(id) => (
            <textarea
              id={id}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
              rows={4}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="systemctl restart nginx && systemctl status nginx --no-pager"
              className="w-full resize-y rounded-btn border border-input-border bg-input px-3 py-2 font-mono text-[13px] text-fg shadow-sm outline-none transition-[border-color,box-shadow] select-text placeholder:text-fg-muted/70 focus:border-fg-muted focus:ring-4 focus:ring-ring"
            />
          )}
        </Field>
        {isDangerousCommand(command) && (
          <p className="flex items-center gap-1.5 text-xs text-amber">
            <ShieldAlert className="size-3.5" />
            {t("snippets.dangerNote")}
          </p>
        )}
      </form>
    </Modal>
  );
}
