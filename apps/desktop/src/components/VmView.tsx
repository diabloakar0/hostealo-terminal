import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Info, Layers, LoaderCircle, Play, Power, RefreshCw, RotateCw, Search, SquareTerminal, Zap } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { formatBytes, formatUptime } from "../lib/format";
import { actionCommand, consoleCommand, libvirtMachines, parseProxmox, vmAccessProblem, type Hypervisor, type VirtualMachine, type VmAction } from "../lib/virt";
import { useRemoteConnection } from "../hooks/useRemoteConnection";
import { useHosts } from "../store/hosts";
import { useTabs, type Tab } from "../store/tabs";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Form";
import { Badge } from "./ui/Page";

const REFRESH_MS = 5000;
const LIBVIRT = "virsh -c qemu:///system";

type Access =
  | { ok: true; hypervisor: Hypervisor; prefix: string; sudo: boolean; version: string; node: string }
  | { ok: false; reason: "none" | "permission" | "daemon"; detail: string };

/** The virtual machines of a Proxmox node (its whole cluster) or a KVM host (SolusVM 2 nodes). */
export function VmView({ tab, active }: { tab: Tab; active: boolean }) {
  const { t } = useTranslation();
  const host = useHosts((s) => s.hosts.find((h) => h.id === tab.hostId));
  const { connection, connectError, reconnect, run } = useRemoteConnection(tab);
  const [access, setAccess] = useState<Access | null>(null);
  const [machines, setMachines] = useState<VirtualMachine[] | null>(null);
  const [busy, setBusy] = useState<Record<string, VmAction>>({});
  const [filter, setFilter] = useState("");
  const [forceOff, setForceOff] = useState<VirtualMachine | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** libvirt's CPU time per domain at the last refresh, for CPU use. */
  const cpuTimes = useRef(new Map<string, { cpuTimeNs: number; at: number }>());

  useEffect(() => {
    if (connection !== null) return;
    setAccess(null);
    setMachines(null);
  }, [connection]);

  // What runs here, and whether this user can drive it (directly or with passwordless sudo).
  useEffect(() => {
    if (connection === null) return;
    void (async () => {
      const probe = await run("if command -v pvesh >/dev/null 2>&1; then echo proxmox; elif command -v virsh >/dev/null 2>&1; then echo libvirt; else echo none; fi; hostname");
      const [kind, node = ""] = probe.stdout.trim().split("\n");
      if (kind !== "proxmox" && kind !== "libvirt") return setAccess({ ok: false, reason: "none", detail: "" });
      const hypervisor = kind as Hypervisor;
      const base = hypervisor === "proxmox" ? "pvesh" : LIBVIRT;
      const test = hypervisor === "proxmox" ? "get /version --output-format json" : "list --name";
      for (const sudo of [false, true]) {
        const prefix = sudo ? `sudo -n ${base}` : base;
        const out = await run(`${prefix} ${test} 2>&1`);
        if (out.exitCode !== 0) continue;
        let version = "";
        if (hypervisor === "proxmox") {
          try {
            version = `Proxmox VE ${JSON.parse(out.stdout).version}`;
          } catch {
            version = "Proxmox VE";
          }
        } else {
          version = `KVM · libvirt ${(await run("virsh --version 2>/dev/null")).stdout.trim()}`;
        }
        return setAccess({ ok: true, hypervisor, prefix, sudo, version, node: node.trim() });
      }
      const failed = await run(`${base} ${test} 2>&1`);
      const detail = (failed.stdout + failed.stderr).trim();
      setAccess({ ok: false, reason: vmAccessProblem(detail), detail });
    })().catch((e) => setError(String(e)));
  }, [connection, run]);

  const ready = access?.ok ? access : null;

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      if (ready.hypervisor === "proxmox") {
        const out = await run(`${ready.prefix} get /cluster/resources --type vm --output-format json`);
        if (out.exitCode !== 0) throw new Error((out.stderr || out.stdout).trim());
        setMachines(parseProxmox(out.stdout));
      } else {
        const [list, stats] = await Promise.all([run(`${ready.prefix} list --all --title`), run(`${ready.prefix} domstats --raw --state --cpu-total --balloon --vcpu`)]);
        if (list.exitCode !== 0) throw new Error((list.stderr || list.stdout).trim());
        const at = Date.now();
        const vms = libvirtMachines(list.stdout, stats.stdout, cpuTimes.current, at);
        // Remember this reading for the next CPU figure.
        for (const line of stats.stdout.split("Domain:").slice(1)) {
          const name = /^\s*'?(.+?)'?\s*$/m.exec(line)?.[1];
          const time = /cpu\.time=(\d+)/.exec(line)?.[1];
          if (name && time) cpuTimes.current.set(name, { cpuTimeNs: Number(time), at });
        }
        setMachines(vms);
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [ready, run]);

  useEffect(() => {
    if (!ready) return;
    void refresh();
    if (!active) return;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [ready, active, refresh]);

  const act = async (vm: VirtualMachine, action: VmAction) => {
    if (!ready) return;
    setBusy((b) => ({ ...b, [vm.key]: action }));
    try {
      const out = await run(actionCommand(ready.hypervisor, ready.prefix, vm, action), 120);
      if (out.exitCode !== 0) setError((out.stderr || out.stdout).trim());
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(({ [vm.key]: _done, ...rest }) => rest);
    }
  };

  const openConsole = (vm: VirtualMachine) => {
    if (!ready || !tab.hostId) return;
    const command = consoleCommand(ready.hypervisor, ready.sudo, vm, ready.node);
    if (command) useTabs.getState().openSsh(tab.hostId, command);
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (machines ?? []).filter((vm) => !q || vm.name.toLowerCase().includes(q) || vm.ref.toLowerCase().includes(q) || (vm.node ?? "").toLowerCase().includes(q));
  }, [machines, filter]);
  const nodes = new Set((machines ?? []).map((vm) => vm.node).filter(Boolean));
  const showNode = nodes.size > 1;
  const running = (machines ?? []).filter((vm) => vm.state === "running").length;

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
            {connection === null ? t("docker.connecting", { name: host?.name ?? "" }) : t("vms.checking")}
          </p>
        )}
      </Centered>
    );
  }

  if (!access.ok) {
    return (
      <Centered>
        <Layers className="mx-auto size-7 text-fg-muted" />
        <p className="mt-3 text-sm font-medium text-fg">{t(`vms.problem.${access.reason}.title`)}</p>
        <p className="mt-1 text-sm leading-relaxed text-fg-muted">{t(`vms.problem.${access.reason}.hint`)}</p>
        {access.detail && <pre className="mt-3 max-h-32 overflow-auto rounded-btn border border-border bg-deep p-2 text-left font-mono text-xs whitespace-pre-wrap text-fg-secondary">{access.detail}</pre>}
        <Button className="mt-4" onClick={reconnect}>
          <RefreshCw className="size-4" />
          {t("docker.retry")}
        </Button>
      </Centered>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className="grid size-9 place-items-center rounded-card-deep bg-badge text-accent">
          <Layers className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold text-fg">{t("vms.title", { name: host?.name ?? "" })}</h1>
          <p className="text-xs text-fg-muted">
            {access.version} · {t("vms.counts", { running, total: machines?.length ?? 0 })}
            {showNode && ` · ${t("vms.nodes", { count: nodes.size })}`}
            {access.sudo && ` · ${t("docker.viaSudo")}`}
          </p>
        </div>
        <div className="relative ml-auto w-56 min-w-28 shrink">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-muted" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("vms.filter")} className="h-8 pl-8" />
        </div>
        <Button size="sm" className="shrink-0" onClick={() => void refresh()} title={t("common.refresh")}>
          <RefreshCw className="size-3.5" />
        </Button>
      </header>

      {access.hypervisor === "libvirt" && (
        <p className="flex items-center gap-2 border-b border-border bg-deep px-5 py-2 text-xs text-fg-muted">
          <Info className="size-3.5 shrink-0" />
          {t("vms.libvirtNote")}
        </p>
      )}
      {error && <p className="border-b border-border bg-red/5 px-5 py-2 text-xs break-words text-red">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {machines === null ? (
          <p className="flex items-center gap-2 px-5 py-6 text-sm text-fg-muted">
            <LoaderCircle className="size-4 animate-spin" />
            {t("docker.loading")}
          </p>
        ) : shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-fg-muted">{machines.length === 0 ? t("vms.empty") : t("vms.noMatches")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-left text-xs text-fg-muted">
              <tr className="border-b border-border">
                <th className="py-2 pr-2 pl-5 font-medium">{t("vms.name")}</th>
                {showNode && <th className="px-2 font-medium">{t("vms.node")}</th>}
                <th className="px-2 font-medium">{t("docker.state")}</th>
                <th className="px-2 text-right font-medium">CPU</th>
                <th className="px-2 text-right font-medium">{t("docker.memory")}</th>
                <th className="px-2 text-right font-medium">{t("vms.disk")}</th>
                <th className="w-44 pr-5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((vm) => {
                const pending = busy[vm.key];
                const up = vm.state === "running";
                const consoleCmd = ready && consoleCommand(ready.hypervisor, ready.sudo, vm, ready.node);
                return (
                  <tr key={vm.key} className="group border-b border-border hover:bg-muted/40">
                    <td className="max-w-72 py-2 pr-2 pl-5">
                      <span className="flex items-center gap-2">
                        <StateDot state={vm.state} />
                        <span className="truncate font-medium text-fg" title={vm.name}>
                          {vm.name}
                        </span>
                        <span className="shrink-0 font-mono text-xs text-fg-muted">{vm.kind === "kvm" ? (vm.name !== vm.ref ? vm.ref : "") : vm.ref}</span>
                        <Badge className="shrink-0">{vm.template ? t("vms.template") : vm.kind === "lxc" ? "CT" : "VM"}</Badge>
                      </span>
                    </td>
                    {showNode && <td className="px-2 text-xs text-fg-secondary">{vm.node}</td>}
                    <td className="px-2 text-xs whitespace-nowrap text-fg-muted">
                      {t(`vms.state.${vm.state}`, { defaultValue: vm.stateLabel })}
                      {vm.uptimeSecs ? ` · ${formatUptime(vm.uptimeSecs)}` : ""}
                    </td>
                    <td className="px-2 text-right text-xs text-fg-secondary tabular-nums">
                      {up && vm.cpuPercent !== null && `${vm.cpuPercent.toFixed(1)}% · `}
                      {vm.cpus ? <span className="text-fg-muted">{t("vms.cores", { count: vm.cpus })}</span> : null}
                    </td>
                    <td className="px-2 text-right text-xs whitespace-nowrap text-fg-secondary tabular-nums">
                      {up && vm.memUsed !== null ? `${formatBytes(vm.memUsed)} / ` : ""}
                      {vm.memTotal ? formatBytes(vm.memTotal) : ""}
                    </td>
                    <td className="px-2 text-right text-xs whitespace-nowrap text-fg-secondary tabular-nums">
                      {vm.diskUsed !== null && vm.diskUsed > 0 ? `${formatBytes(vm.diskUsed)} / ` : ""}
                      {vm.diskTotal ? formatBytes(vm.diskTotal) : ""}
                    </td>
                    <td className="pr-5">
                      <span className="flex justify-end gap-0.5">
                        {vm.template ? null : pending ? (
                          <LoaderCircle className="m-1.5 size-4 animate-spin text-fg-muted" />
                        ) : up ? (
                          <>
                            {consoleCmd && (
                              <RowButton label={t("vms.console")} onClick={() => openConsole(vm)}>
                                <SquareTerminal />
                              </RowButton>
                            )}
                            <RowButton label={t("vms.reboot")} onClick={() => void act(vm, "reboot")}>
                              <RotateCw />
                            </RowButton>
                            <RowButton label={t("vms.shutdown")} onClick={() => void act(vm, "shutdown")}>
                              <Power />
                            </RowButton>
                            <RowButton label={t("vms.forceOff")} onClick={() => setForceOff(vm)} className="hover:!text-red">
                              <Zap />
                            </RowButton>
                          </>
                        ) : (
                          <RowButton label={t("vms.start")} onClick={() => void act(vm, "start")} className="text-green">
                            <Play />
                          </RowButton>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {forceOff && (
        <ConfirmDialog
          title={t("vms.forceOffTitle", { name: forceOff.name })}
          confirmLabel={t("vms.forceOff")}
          icon={<Zap className="size-4" />}
          onConfirm={() => act(forceOff, "stop")}
          onClose={() => setForceOff(null)}
        >
          {t("vms.forceOffBody")}
        </ConfirmDialog>
      )}
    </div>
  );
}

function StateDot({ state }: { state: VirtualMachine["state"] }) {
  const color = state === "running" ? "bg-green" : state === "paused" ? "bg-amber" : state === "other" ? "bg-red" : "bg-fg-muted/50";
  return <span className={cn("size-2 shrink-0 rounded-full", color)} />;
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
