import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Activity, ArrowDown, ArrowUp, BellOff, CircleAlert, Monitor, Server, Trash2, Unplug } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { alertText } from "../lib/alertWatch";
import { formatRate, formatUptime } from "../lib/format";
import type { Host } from "../lib/ipc";
import { useHostAccent } from "../hooks/useHostColor";
import { useAlerts, type Alert } from "../store/alerts";
import { useHosts } from "../store/hosts";
import { useMonitors, type MonitorEntry } from "../store/monitor";
import { useSettings } from "../store/settings";
import { useTabs, type Tab } from "../store/tabs";
import { hostOsId, OsIcon } from "./OsIcon";
import { Usage } from "./ResourceBar";
import { Sparkline } from "./Sparkline";
import { StatusDot } from "./StatusDot";
import { Button } from "./ui/Button";
import { Badge, Page } from "./ui/Page";

interface Connected {
  host: Host;
  /** The tab whose monitor is shown (and that a click goes back to). */
  tab: Tab;
  entry: MonitorEntry | undefined;
}

/** The servers with an open session, live, and the alerts about them. */
export function StatusView() {
  const { t } = useTranslation();
  const tabs = useTabs((s) => s.tabs);
  const hosts = useHosts((s) => s.hosts);
  const entries = useMonitors((s) => s.entries);
  const alerts = useAlerts((s) => s.alerts);
  const alertsEnabled = useSettings((s) => s.alertsEnabled);

  // One card per server with an SSH session; other kinds of sessions get a line.
  const { servers, others } = useMemo(() => {
    const servers: Connected[] = [];
    const others: Connected[] = [];
    for (const tab of tabs) {
      const host = hosts.find((h) => h.id === tab.hostId);
      if (!host || tab.status === "closed") continue;
      if (tab.kind === "ssh") {
        const existing = servers.find((s) => s.host.id === host.id);
        const entry = entries[tab.id];
        if (!existing) servers.push({ host, tab, entry });
        else if (!existing.entry?.snapshot && entry?.snapshot) Object.assign(existing, { tab, entry });
      } else if ((tab.kind === "rdp" || tab.kind === "sftp" || tab.kind === "ftp") && !others.some((o) => o.host.id === host.id && o.tab.kind === tab.kind)) {
        others.push({ host, tab, entry: undefined });
      }
    }
    return { servers, others };
  }, [tabs, hosts, entries]);

  const active = alerts.filter((a) => a.active);

  return (
    <Page
      icon={<Activity className="size-5" />}
      title={t("status.title")}
      description={t("status.description")}
      actions={
        alerts.length > active.length && (
          <Button size="sm" onClick={() => useAlerts.getState().clear()}>
            <Trash2 className="size-3.5" />
            {t("status.clearResolved")}
          </Button>
        )
      }
    >
      {!alertsEnabled && (
        <p className="flex items-center gap-2 rounded-card border border-border bg-deep px-4 py-2.5 text-sm text-fg-muted">
          <BellOff className="size-4" />
          {t("status.alertsOff")}
        </p>
      )}

      {servers.length === 0 && others.length === 0 ? (
        <div className="rounded-card border border-dashed border-border px-6 py-12 text-center">
          <Server className="mx-auto size-7 text-fg-muted" />
          <p className="mt-3 font-medium text-fg">{t("status.emptyTitle")}</p>
          <p className="mt-1 text-sm text-fg-muted">{t("status.emptyHint")}</p>
        </div>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {servers.map((server) => (
            <ServerCard key={server.host.id} server={server} alerts={active.filter((a) => a.hostId === server.host.id)} />
          ))}
        </div>
      )}

      {others.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-fg">{t("status.otherSessions")}</h2>
          <ul className="flex flex-wrap gap-2">
            {others.map(({ host, tab }) => (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => useTabs.getState().activate(tab.id)}
                  className="flex cursor-pointer items-center gap-2 rounded-btn border border-border bg-card px-3 py-1.5 text-sm shadow-sm hover:bg-muted"
                >
                  <StatusDot status={tab.status} small />
                  {tab.kind === "rdp" ? <Monitor className="size-3.5 text-fg-muted" /> : <Server className="size-3.5 text-fg-muted" />}
                  <span className="text-fg">{host.name}</span>
                  <span className="text-xs text-fg-muted">{tab.kind.toUpperCase()}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {alerts.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-fg">{t("status.alerts")}</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

function ServerCard({ server, alerts }: { server: Connected; alerts: Alert[] }) {
  const { t } = useTranslation();
  const accent = useHostAccent(server.host.id);
  const snapshot = server.entry?.snapshot;
  const osId = hostOsId(server.host);

  return (
    <button
      type="button"
      onClick={() => useTabs.getState().activate(server.tab.id)}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-3 rounded-card border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/40",
        alerts.length > 0 ? "border-red/50" : "border-border",
      )}
    >
      <header className="flex items-center gap-2.5">
        {osId ? <OsIcon id={osId} color={accent?.hex} /> : <Server className="size-4 shrink-0" style={accent ? { color: accent.hex } : undefined} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-fg">{server.host.name}</span>
          <span className="block truncate text-xs text-fg-muted">
            {snapshot ? `${snapshot.os ?? server.host.hostname} · ${t("monitor.uptime")} ${formatUptime(snapshot.uptimeSecs)}` : server.host.hostname}
          </span>
        </span>
        <StatusDot status={server.tab.status} />
      </header>

      {alerts.length > 0 && (
        <ul className="flex flex-col gap-1">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex items-center gap-1.5 text-xs font-medium text-red">
              <CircleAlert className="size-3.5 shrink-0" />
              {alertText(alert)}
            </li>
          ))}
        </ul>
      )}

      {snapshot ? (
        <>
          <div>
            <div className="mb-1 flex justify-between text-xs tabular-nums">
              <span className="text-fg-secondary">{t("monitor.cpu")}</span>
              <span className="text-fg-muted">
                {snapshot.cpuPercent.toFixed(0)}% · {t("monitor.cores", { count: snapshot.cpuCount })}
                {snapshot.load && ` · ${t("monitor.load")} ${snapshot.load[0].toFixed(2)}`}
              </span>
            </div>
            <Sparkline values={server.entry!.history.cpu} max={100} width={280} height={28} className="w-full text-accent" />
          </div>
          <Usage label={t("monitor.ram")} used={snapshot.memUsed} total={snapshot.memTotal} />
          {snapshot.disks.slice(0, 2).map((disk) => (
            <Usage key={disk.mount} label={disk.mount} used={disk.used} total={disk.total} />
          ))}
          <p className="flex gap-3 text-xs text-fg-secondary tabular-nums">
            <span className="flex items-center gap-0.5">
              <ArrowDown className="size-3 text-green" /> {formatRate(snapshot.netRxBps)}
            </span>
            <span className="flex items-center gap-0.5">
              <ArrowUp className="size-3 text-blue" /> {formatRate(snapshot.netTxBps)}
            </span>
          </p>
        </>
      ) : (
        <p className="text-sm text-fg-muted">
          {server.entry?.unsupported ? t("status.noMetrics") : server.tab.status === "failed" ? t("status.disconnected") : t("status.waiting")}
        </p>
      )}
    </button>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
      {alert.kind === "disconnected" ? (
        <Unplug className={cn("size-4 shrink-0", alert.active ? "text-red" : "text-fg-muted")} />
      ) : (
        <CircleAlert className={cn("size-4 shrink-0", alert.active ? "text-red" : "text-fg-muted")} />
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-fg">{alert.hostName}</span>
        <span className="text-fg-secondary"> · {alertText(alert)}</span>
      </span>
      {alert.active ? <Badge tone="warning">{t("status.ongoing")}</Badge> : <Badge>{t("status.resolved")}</Badge>}
      <span className="w-12 shrink-0 text-right text-xs text-fg-muted tabular-nums">
        {new Date(alert.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    </li>
  );
}
