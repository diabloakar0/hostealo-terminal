import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Eraser, Fingerprint, Lock, RefreshCw, Search, Trash2 } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { knownHostsForget, knownHostsList, knownHostsRemove, type KnownHostEntry } from "../lib/ipc";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Form";
import { Badge, Page } from "./ui/Page";

const keyOf = (e: KnownHostEntry) => `${e.source}:${e.line}`;

/** Looks like a host the user could forget: no spaces, at least one dot or colon. */
const looksLikeHost = (query: string) => /^[\w.:[\]-]+$/.test(query) && /[.:]/.test(query);

type Pending = { kind: "forget"; target: string } | { kind: "remove"; entries: KnownHostEntry[] } | null;

export function KnownHostsView() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const load = useCallback(async (search: string) => {
    try {
      setEntries(await knownHostsList(search.trim()));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Searching hashed entries means hashing the query, so it runs in Rust; debounce typing.
  useEffect(() => {
    const timer = setTimeout(() => void load(query), 150);
    return () => clearTimeout(timer);
  }, [query, load]);

  useEffect(() => setSelected(new Set()), [entries]);

  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(keyOf(e))), [entries, selected]);
  const target = query.trim();

  const confirm = async () => {
    if (!pending) return;
    const removed =
      pending.kind === "forget" ? await knownHostsForget(pending.target) : await knownHostsRemove(pending.entries);
    setNotice(t("knownHosts.removed", { count: removed }));
    await load(query);
  };

  const toggle = (entry: KnownHostEntry) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(keyOf(entry))) next.delete(keyOf(entry));
      else next.add(keyOf(entry));
      return next;
    });

  return (
    <Page
      icon={<Fingerprint className="size-5" />}
      title={t("knownHosts.title")}
      description={t("knownHosts.description")}
      actions={
        <Button onClick={() => void load(query)} title={t("common.refresh")} aria-label={t("common.refresh")}>
          <RefreshCw className="size-4" />
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setNotice(null);
            }}
            placeholder={t("knownHosts.search")}
            className="pl-9"
          />
        </div>
        {looksLikeHost(target) && (
          <Button variant="primary" onClick={() => setPending({ kind: "forget", target })}>
            <Eraser className="size-4" />
            {t("knownHosts.forget", { target })}
          </Button>
        )}
        {selectedEntries.length > 0 && (
          <Button onClick={() => setPending({ kind: "remove", entries: selectedEntries })}>
            <Trash2 className="size-4" />
            {t("knownHosts.removeSelected", { count: selectedEntries.length })}
          </Button>
        )}
      </div>

      {notice && <p className="rounded-btn border border-green/25 bg-green/10 px-3 py-2 text-sm text-green">{notice}</p>}
      {error && <p className="text-sm text-red">{error}</p>}

      <div className="overflow-hidden rounded-card border border-border bg-card shadow-sm">
        <table className="w-full table-fixed text-sm">
          <thead className="border-b border-border bg-deep text-left text-xs text-fg-muted">
            <tr>
              <th className="w-10 px-3 py-2" />
              <th className="px-3 py-2 font-medium">{t("knownHosts.host")}</th>
              <th className="w-40 px-3 py-2 font-medium">{t("hostKey.algorithm")}</th>
              <th className="px-3 py-2 font-medium">{t("hostKey.fingerprint")}</th>
              <th className="w-40 px-3 py-2 font-medium">{t("knownHosts.source")}</th>
              <th className="w-12 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const isSelected = selected.has(keyOf(entry));
              return (
                <tr
                  key={keyOf(entry)}
                  onClick={() => toggle(entry)}
                  className={cn("group cursor-pointer border-b border-border last:border-0", isSelected ? "bg-badge" : "hover:bg-muted/50")}
                >
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={isSelected} readOnly className="accent-[var(--accent-button)]" aria-label={t("knownHosts.select")} />
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-[13px] text-fg">
                    {entry.hashed ? (
                      <span className="inline-flex items-center gap-1.5 font-sans text-fg-muted" title={t("knownHosts.hashedHint")}>
                        <Lock className="size-3.5" />
                        {t("knownHosts.hashed")}
                      </span>
                    ) : (
                      entry.hosts.join(", ")
                    )}
                    {entry.marker && <Badge className="ml-2 font-sans">{entry.marker}</Badge>}
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-xs text-fg-secondary">{entry.keyType}</td>
                  <td className="truncate px-3 py-2 font-mono text-xs text-fg-secondary select-text" title={entry.fingerprint ?? ""}>
                    {entry.fingerprint ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={entry.source === "app" ? "info" : "default"}>
                      {entry.source === "app" ? t("knownHosts.sourceApp") : "~/.ssh/known_hosts"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPending({ kind: "remove", entries: [entry] });
                      }}
                      className="invisible cursor-pointer rounded p-1 text-fg-muted hover:bg-muted hover:text-red group-hover:visible"
                      title={t("sidebar.delete")}
                      aria-label={t("sidebar.delete")}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-sm text-fg-muted">
                  {query ? t("knownHosts.noMatches") : t("knownHosts.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-fg-muted">{t("knownHosts.backupNote")}</p>

      {pending && (
        <ConfirmDialog
          title={t("knownHosts.confirmTitle")}
          confirmLabel={t("sidebar.delete")}
          onConfirm={confirm}
          onClose={() => setPending(null)}
        >
          {pending.kind === "forget" ? (
            <Trans i18nKey="knownHosts.confirmForget" values={{ target: pending.target }} components={{ b: <strong className="font-mono text-fg" /> }} />
          ) : (
            t("knownHosts.confirmRemove", { count: pending.entries.length })
          )}
        </ConfirmDialog>
      )}
    </Page>
  );
}
