import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Monitor, Server } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import type { ResourceSnapshot } from "../lib/ipc";
import { formatBytes, formatRate, formatUptime, percent, usageTone } from "../lib/format";
import type { MonitorEntry, MonitorHistory } from "../store/monitor";
import type { TabStatus } from "../store/tabs";
import { Sparkline } from "./Sparkline";
import { StatusDot } from "./StatusDot";

const TONE_TEXT = { normal: "text-fg", warning: "text-amber", critical: "text-red" } as const;
const TONE_FILL = { normal: "bg-accent", warning: "bg-amber", critical: "bg-red" } as const;

interface ResourceMonitorProps {
  entry: MonitorEntry | undefined;
  kind: "local" | "ssh";
  status: TabStatus;
  /** "This computer" or the host name. */
  label: string;
  /** Host colour, for the icon. */
  accent?: string;
  expanded: boolean;
  onToggle: () => void;
}

const EMPTY_HISTORY: MonitorHistory = { cpu: [], rx: [], tx: [] };

/** Status bar under the terminal, plus the expandable detail panel above it. */
export function ResourceMonitor(props: ResourceMonitorProps) {
  const snapshot = props.entry?.snapshot ?? null;
  return (
    <div className="@container shrink-0 border-t border-border bg-deep">
      {props.expanded && snapshot && <ResourceDetails snapshot={snapshot} history={props.entry!.history} />}
      <ResourceBar {...props} />
    </div>
  );
}

function ResourceBar({ entry, kind, status, label, accent, expanded, onToggle }: ResourceMonitorProps) {
  const { t } = useTranslation();
  const snapshot = entry?.snapshot ?? null;
  const history = entry?.history ?? EMPTY_HISTORY;
  const Icon = kind === "ssh" ? Server : Monitor;
  const placeholder = entry?.unsupported
    ? t("monitor.unsupported")
    : status === "connected"
      ? t("monitor.waiting")
      : t(`monitor.status.${status}`);
  const memPct = snapshot ? percent(snapshot.memUsed, snapshot.memTotal) : 0;
  const disk = snapshot?.disks[0];
  const diskPct = disk ? percent(disk.used, disk.total) : 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? t("monitor.hideDetails") : t("monitor.showDetails")}
      className="flex h-8 w-full cursor-pointer items-center gap-4 whitespace-nowrap px-3 text-left text-xs text-fg-muted tabular-nums transition-colors hover:bg-muted/60"
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot status={status} />
        <Icon className="size-3.5 shrink-0" style={accent ? { color: accent } : undefined} />
        <span className="truncate font-medium text-fg-secondary">{label}</span>
        {snapshot?.hostname && snapshot.hostname !== label && <span className="hidden truncate @3xl:inline">· {snapshot.hostname}</span>}
      </span>

      {!snapshot ? (
        <span className="ml-auto truncate">{placeholder}</span>
      ) : (
        <span className="ml-auto flex items-center gap-4">
          <Metric label={t("monitor.cpu")}>
            <Sparkline values={history.cpu} max={100} width={48} height={14} className="text-accent" />
            <span className={cn("w-9 text-right", TONE_TEXT[usageTone(snapshot.cpuPercent)])}>
              {snapshot.cpuPercent.toFixed(0)}%
            </span>
          </Metric>
          <Metric label={t("monitor.ram")}>
            <span className={TONE_TEXT[usageTone(memPct)]}>
              {formatBytes(snapshot.memUsed)} / {formatBytes(snapshot.memTotal, 0)}
            </span>
          </Metric>
          {disk && (
            <Metric label={t("monitor.disk")} className="hidden @lg:flex">
              <span className={TONE_TEXT[usageTone(diskPct)]}>{diskPct.toFixed(0)}%</span>
            </Metric>
          )}
          <span className="hidden items-center gap-2 text-fg-secondary @3xl:flex">
            <span className="flex items-center gap-0.5">
              <ArrowDown className="size-3 text-green" />
              {formatRate(snapshot.netRxBps)}
            </span>
            <span className="flex items-center gap-0.5">
              <ArrowUp className="size-3 text-blue" />
              {formatRate(snapshot.netTxBps)}
            </span>
          </span>
          {snapshot.load && (
            <Metric label={t("monitor.load")} className="hidden @5xl:flex">
              <span className="text-fg-secondary">{snapshot.load[0].toFixed(2)}</span>
            </Metric>
          )}
          <Metric label={t("monitor.uptime")} className="hidden @5xl:flex">
            <span className="text-fg-secondary">{formatUptime(snapshot.uptimeSecs)}</span>
          </Metric>
        </span>
      )}

      {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronUp className="size-3.5 shrink-0" />}
    </button>
  );
}

function Metric({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <span>{label}</span>
      {children}
    </span>
  );
}

function ResourceDetails({ snapshot, history }: { snapshot: ResourceSnapshot; history: MonitorHistory }) {
  const { t } = useTranslation();
  const netMax = Math.max(...history.rx, ...history.tx, 1);

  return (
    <div className="grid grid-cols-2 gap-3 border-b border-border p-3 @4xl:grid-cols-4">
      <Card title={t("monitor.cpu")} aside={`${snapshot.cpuPercent.toFixed(0)}%`}>
        <Sparkline values={history.cpu} max={100} width={240} height={44} className="w-full text-accent" />
        <p className="mt-2 text-xs text-fg-muted">
          {t("monitor.cores", { count: snapshot.cpuCount })}
          {snapshot.load && ` · ${t("monitor.load")} ${snapshot.load.map((l) => l.toFixed(2)).join(" ")}`}
        </p>
      </Card>

      <Card title={t("monitor.ram")}>
        <Usage label={t("monitor.ram")} used={snapshot.memUsed} total={snapshot.memTotal} />
        {snapshot.swapTotal > 0 && <Usage label={t("monitor.swap")} used={snapshot.swapUsed} total={snapshot.swapTotal} />}
        <p className="mt-2 text-xs text-fg-muted">
          {snapshot.os} · {t("monitor.uptime")} {formatUptime(snapshot.uptimeSecs)}
        </p>
      </Card>

      <Card title={t("monitor.disks")}>
        {snapshot.disks.slice(0, 3).map((d) => (
          <Usage key={d.mount} label={d.mount} used={d.used} total={d.total} />
        ))}
      </Card>

      <Card title={t("monitor.network")}>
        <div className="relative h-11">
          <Sparkline values={history.rx} max={netMax} width={240} height={44} className="absolute inset-0 w-full text-green" />
          <Sparkline values={history.tx} max={netMax} width={240} height={44} className="absolute inset-0 w-full text-blue" />
        </div>
        <p className="mt-2 flex gap-3 text-xs text-fg-secondary tabular-nums">
          <span className="flex items-center gap-0.5">
            <ArrowDown className="size-3 text-green" /> {formatRate(snapshot.netRxBps)}
          </span>
          <span className="flex items-center gap-0.5">
            <ArrowUp className="size-3 text-blue" /> {formatRate(snapshot.netTxBps)}
          </span>
        </p>
      </Card>
    </div>
  );
}

function Card({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-card-deep border border-border bg-card p-3">
      <header className="mb-2 flex items-center justify-between text-xs font-medium text-fg-secondary">
        <h3 className="font-sans tracking-normal">{title}</h3>
        {aside && <span className="tabular-nums text-fg">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

export function Usage({ label, used, total }: { label: string; used: number; total: number }) {
  const value = percent(used, total);
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex justify-between gap-2 text-xs tabular-nums">
        <span className="truncate text-fg-secondary">{label}</span>
        <span className="shrink-0 text-fg-muted">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", TONE_FILL[usageTone(value)])} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
