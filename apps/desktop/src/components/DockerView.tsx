import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Container as ContainerIcon, FileText, LoaderCircle, Play, RefreshCw, RotateCw, Search, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { accessProblem, execShell, parseContainers, parseStats, safeId, statsFor, type Container, type ContainerStats, type DockerAccess } from "../lib/docker";
import { useRemoteConnection } from "../hooks/useRemoteConnection";
import { useHosts } from "../store/hosts";
import { useTabs, type Tab } from "../store/tabs";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Form";
import { Badge } from "./ui/Page";

/** How often the list and the stats refresh while the tab is in front. */
const REFRESH_MS = 5000;
const LOG_LINES = 500;

type Action = "start" | "stop" | "restart";

/** A server's Docker: containers grouped by Compose project, with their stats, logs and a shell. */
export function DockerView({ tab, active }: { tab: Tab; active: boolean }) {
  const { t } = useTranslation();
  const host = useHosts((s) => s.hosts.find((h) => h.id === tab.hostId));
  const { connection, connectError, reconnect, run } = useRemoteConnection(tab);
  const [access, setAccess] = useState<DockerAccess | null>(null);
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [stats, setStats] = useState<Map<string, ContainerStats>>(new Map());
  const [busy, setBusy] = useState<Record<string, Action | "remove">>({});
  const [filter, setFilter] = useState("");
  const [logsOf, setLogsOf] = useState<Container | null>(null);
  const [removing, setRemoving] = useState<Container | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new connection starts over.
  useEffect(() => {
    if (connection !== null) return;
    setAccess(null);
    setContainers(null);
  }, [connection]);

  // How docker runs for this user: directly, with passwordless sudo, or not at all.
  useEffect(() => {
    if (connection === null) return;
    void (async () => {
      const direct = await run("docker version --format '{{.Server.Version}}' 2>&1");
      if (direct.exitCode === 0) return setAccess({ ok: true, prefix: "docker", version: direct.stdout.trim() });
      const reason = accessProblem(direct.stdout + direct.stderr, direct.exitCode);
      if (reason === "permission") {
        const sudo = await run("sudo -n docker version --format '{{.Server.Version}}' 2>&1");
        if (sudo.exitCode === 0) return setAccess({ ok: true, prefix: "sudo -n docker", version: sudo.stdout.trim() });
      }
      setAccess({ ok: false, reason, detail: (direct.stdout + direct.stderr).trim() });
    })().catch((e) => setError(String(e)));
  }, [connection, run]);

  const prefix = access?.ok ? access.prefix : null;

  const refresh = useCallback(async () => {
    if (!prefix) return;
    try {
      const [list, usage] = await Promise.all([
        run(`${prefix} ps -a --no-trunc --format '{{json .}}'`),
        run(`${prefix} stats --no-stream --format '{{json .}}'`, 30),
      ]);
      if (list.exitCode !== 0) throw new Error(list.stderr.trim() || list.stdout.trim());
      setContainers(parseContainers(list.stdout));
      setStats(parseStats(usage.stdout));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [prefix, run]);

  // First load, then every few seconds while the tab is in front.
  useEffect(() => {
    if (!prefix) return;
    void refresh();
    if (!active) return;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [prefix, active, refresh]);

  const act = async (container: Container, action: Action | "remove") => {
    if (!prefix) return;
    setBusy((b) => ({ ...b, [container.id]: action }));
    try {
      const command = action === "remove" ? `${prefix} rm -f ${safeId(container.id)}` : `${prefix} ${action} ${safeId(container.id)}`;
      const out = await run(command, 120);
      if (out.exitCode !== 0) setError((out.stderr || out.stdout).trim());
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(({ [container.id]: _done, ...rest }) => rest);
    }
  };

  const openShell = (container: Container) => {
    if (prefix && tab.hostId) useTabs.getState().openSsh(tab.hostId, execShell(prefix, container));
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (containers ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || (c.project ?? "").toLowerCase().includes(q));
  }, [containers, filter]);
  const running = (containers ?? []).filter((c) => c.state === "running").length;

  // ── Not ready yet ─────────────────────────────────────────

  if (connection === null || !access) {
    return (
      <Centered>
        {connectError ? (
          <>
            <p className="text-sm font-medium text-fg">{t("docker.connectFailed")}</p>
            <p className="mt-1 text-sm break-words text-red">{connectError}</p>
            <Button variant="primary" className="mt-4" onClick={reconnect}>
              <RefreshCw className="size-4" />
              {t("sftp.reconnect")}
            </Button>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <LoaderCircle className="size-4 animate-spin" />
            {connection === null ? t("docker.connecting", { name: host?.name ?? "" }) : t("docker.checking")}
          </p>
        )}
      </Centered>
    );
  }

  if (!access.ok) {
    return (
      <Centered>
        <ContainerIcon className="mx-auto size-7 text-fg-muted" />
        <p className="mt-3 text-sm font-medium text-fg">{t(`docker.problem.${access.reason}.title`)}</p>
        <p className="mt-1 text-sm leading-relaxed text-fg-muted">{t(`docker.problem.${access.reason}.hint`)}</p>
        {access.detail && <pre className="mt-3 max-h-32 overflow-auto rounded-btn border border-border bg-deep p-2 text-left font-mono text-xs whitespace-pre-wrap text-fg-secondary">{access.detail}</pre>}
        <Button className="mt-4" onClick={reconnect}>
          <RefreshCw className="size-4" />
          {t("docker.retry")}
        </Button>
      </Centered>
    );
  }

  // ── The list ──────────────────────────────────────────────

  let lastProject: string | null | undefined;
  // With the logs open, the image and ports give way to them.
  const compact = logsOf !== null;
  const columns = compact ? 5 : 7;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <span className="grid size-9 place-items-center rounded-card-deep bg-badge text-accent">
            <ContainerIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-fg">{t("docker.title", { name: host?.name ?? "" })}</h1>
            <p className="text-xs text-fg-muted">
              Docker {access.version} · {t("docker.counts", { running, total: containers?.length ?? 0 })}
              {access.prefix.startsWith("sudo") && ` · ${t("docker.viaSudo")}`}
            </p>
          </div>
          <div className="relative ml-auto w-56 min-w-28 shrink">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-muted" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("docker.filter")} className="h-8 pl-8" />
          </div>
          <Button size="sm" className="shrink-0" onClick={() => void refresh()} title={t("common.refresh")}>
            <RefreshCw className="size-3.5" />
          </Button>
        </header>

        {error && <p className="border-b border-border bg-red/5 px-5 py-2 text-xs break-words text-red">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {containers === null ? (
            <p className="flex items-center gap-2 px-5 py-6 text-sm text-fg-muted">
              <LoaderCircle className="size-4 animate-spin" />
              {t("docker.loading")}
            </p>
          ) : shown.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-fg-muted">{containers.length === 0 ? t("docker.empty") : t("docker.noMatches")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-left text-xs text-fg-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-2 pl-5 font-medium">{t("docker.name")}</th>
                  {!compact && <th className="px-2 font-medium">{t("docker.image")}</th>}
                  <th className="px-2 font-medium">{t("docker.state")}</th>
                  {!compact && <th className="px-2 font-medium">{t("docker.ports")}</th>}
                  <th className="px-2 text-right font-medium">CPU</th>
                  <th className="px-2 text-right font-medium">{t("docker.memory")}</th>
                  <th className="w-44 pr-5" />
                </tr>
              </thead>
              <tbody>
                {shown.map((container) => {
                  const header = container.project !== lastProject;
                  lastProject = container.project;
                  const usage = statsFor(stats, container.id);
                  const pending = busy[container.id];
                  const up = container.state === "running";
                  return [
                    header && (
                      <tr key={`p:${container.project ?? "-"}`} className="bg-deep">
                        <td colSpan={columns} className="px-5 py-1.5 text-xs font-medium text-fg-secondary">
                          {container.project ? t("docker.project", { name: container.project }) : t("docker.standalone")}
                        </td>
                      </tr>
                    ),
                    <tr key={container.id} className={cn("group border-b border-border hover:bg-muted/40", logsOf?.id === container.id && "bg-muted/60")}>
                      <td className="max-w-56 py-2 pr-2 pl-5">
                        <span className="flex items-center gap-2">
                          <StateDot state={container.state} />
                          <span className="truncate font-medium text-fg" title={container.name}>
                            {container.name}
                          </span>
                        </span>
                      </td>
                      {!compact && (
                        <td className="max-w-56 truncate px-2 font-mono text-xs text-fg-secondary" title={container.image}>
                          {container.image}
                        </td>
                      )}
                      <td className="px-2 text-xs whitespace-nowrap text-fg-muted">{container.status}</td>
                      {!compact && (
                        <td className="max-w-48 truncate px-2 font-mono text-xs text-fg-muted" title={container.ports}>
                          {container.ports || "—"}
                        </td>
                      )}
                      <td className="px-2 text-right text-xs text-fg-secondary tabular-nums">{up ? (usage?.cpu ?? "…") : ""}</td>
                      <td className="px-2 text-right text-xs text-fg-secondary tabular-nums">{up ? (usage?.memory ?? "…") : ""}</td>
                      <td className="pr-5">
                        <span className="flex justify-end gap-0.5">
                          {pending ? (
                            <LoaderCircle className="m-1.5 size-4 animate-spin text-fg-muted" />
                          ) : (
                            <>
                              <RowButton label={t("docker.logs")} onClick={() => setLogsOf(container)}>
                                <FileText />
                              </RowButton>
                              {up && (
                                <RowButton label={t("docker.shell")} onClick={() => openShell(container)}>
                                  <SquareTerminal />
                                </RowButton>
                              )}
                              {up ? (
                                <>
                                  <RowButton label={t("docker.restart")} onClick={() => void act(container, "restart")}>
                                    <RotateCw />
                                  </RowButton>
                                  <RowButton label={t("docker.stop")} onClick={() => void act(container, "stop")}>
                                    <Square />
                                  </RowButton>
                                </>
                              ) : (
                                <RowButton label={t("docker.start")} onClick={() => void act(container, "start")} className="text-green">
                                  <Play />
                                </RowButton>
                              )}
                              <RowButton label={t("docker.remove")} onClick={() => setRemoving(container)} className="hover:!text-red">
                                <Trash2 />
                              </RowButton>
                            </>
                          )}
                        </span>
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {logsOf && prefix && <LogsPanel key={logsOf.id} container={logsOf} prefix={prefix} run={run} active={active} onClose={() => setLogsOf(null)} />}

      {removing && (
        <ConfirmDialog
          title={t("docker.removeTitle", { name: removing.name })}
          confirmLabel={t("docker.remove")}
          onConfirm={() => act(removing, "remove")}
          onClose={() => setRemoving(null)}
        >
          {t("docker.removeBody")}
        </ConfirmDialog>
      )}
    </div>
  );
}

function LogsPanel({
  container,
  prefix,
  run,
  active,
  onClose,
}: {
  container: Container;
  prefix: string;
  run: (command: string, timeout?: number) => Promise<{ stdout: string; stderr: string }>;
  active: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    // Docker writes the container's stderr to ours: both together, in order.
    const out = await run(`${prefix} logs --tail ${LOG_LINES} --timestamps ${safeId(container.id)} 2>&1`, 30);
    setText(out.stdout || out.stderr);
  }, [container.id, prefix, run]);

  useEffect(() => {
    void load();
    if (!follow || !active) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load, follow, active]);

  // Stay at the end while following.
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, follow]);

  return (
    <aside className="flex w-[44%] min-w-80 flex-col border-l border-border bg-deep">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <FileText className="size-4 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{t("docker.logsOf", { name: container.name })}</span>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[var(--accent)]" />
          {t("docker.follow")}
        </label>
        <Badge>{t("docker.lastLines", { count: LOG_LINES })}</Badge>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="cursor-pointer text-fg-muted hover:text-fg">
          <X className="size-4" />
        </button>
      </header>
      <pre ref={box} className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-secondary select-text [overflow-wrap:anywhere]">
        {text === null ? t("docker.loading") : text.trim() || t("docker.noLogs")}
      </pre>
    </aside>
  );
}

function StateDot({ state }: { state: string }) {
  const color = state === "running" ? "bg-green" : state === "restarting" || state === "paused" ? "bg-amber" : state === "dead" ? "bg-red" : "bg-fg-muted/50";
  return <span className={cn("size-2 shrink-0 rounded-full", color)} title={state} />;
}

function RowButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn("grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors hover:bg-card hover:text-fg [&>svg]:size-3.5", className)}
    >
      {children}
    </button>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-md px-6 text-center">{children}</div>
    </div>
  );
}
