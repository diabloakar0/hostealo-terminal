// Virtual machines on a hypervisor, through its own command line over SSH: Proxmox VE with
// `pvesh` (a whole cluster from any node), and KVM with libvirt's `virsh` (SolusVM 2 nodes and
// any other KVM host). No API keys: the same access the user has in a terminal.

export type Hypervisor = "proxmox" | "libvirt";

export interface VirtualMachine {
  /** Unique in the list: `qemu/100`, `lxc/101`, or the libvirt domain name. */
  key: string;
  /** What actions refer to: the VMID on Proxmox, the domain name on libvirt. */
  ref: string;
  name: string;
  kind: "qemu" | "lxc" | "kvm";
  /** Proxmox node it runs on. */
  node: string | null;
  state: "running" | "stopped" | "paused" | "other";
  /** As the hypervisor says it ("shut off", "running"...). */
  stateLabel: string;
  cpus: number | null;
  cpuPercent: number | null;
  memUsed: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  uptimeSecs: number | null;
  template: boolean;
}

export type VmAction = "start" | "shutdown" | "reboot" | "stop";

const state = (raw: string): VirtualMachine["state"] => {
  const value = raw.toLowerCase();
  if (value === "running") return "running";
  if (value === "stopped" || value === "shut off") return "stopped";
  if (value === "paused" || value === "suspended" || value === "pmsuspended") return "paused";
  return "other";
};

/** `pvesh get /cluster/resources --type vm --output-format json`. */
export function parseProxmox(output: string): VirtualMachine[] {
  let rows: Record<string, unknown>[];
  try {
    rows = JSON.parse(output);
  } catch {
    return [];
  }
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return rows
    .filter((row) => row.type === "qemu" || row.type === "lxc")
    .map((row) => {
      const running = row.status === "running";
      const maxcpu = num(row.maxcpu);
      return {
        key: `${row.type}/${row.vmid}`,
        ref: String(row.vmid),
        name: String(row.name ?? row.vmid),
        kind: row.type as "qemu" | "lxc",
        node: typeof row.node === "string" ? row.node : null,
        state: state(String(row.status ?? "")),
        stateLabel: String(row.status ?? ""),
        cpus: maxcpu,
        // `cpu` is the share of all its cores (0.25 = 25 %).
        cpuPercent: running && num(row.cpu) !== null ? num(row.cpu)! * 100 : null,
        memUsed: running ? num(row.mem) : null,
        memTotal: num(row.maxmem),
        // A VM's disk usage is unknown to Proxmox (0); a container's is real.
        diskUsed: row.type === "lxc" ? num(row.disk) : null,
        diskTotal: num(row.maxdisk),
        uptimeSecs: running ? num(row.uptime) : null,
        template: row.template === 1,
      };
    })
    .sort((a, b) => Number(a.template) - Number(b.template) || Number(a.ref) - Number(b.ref));
}

export interface DomainStats {
  state: number | null;
  cpuTimeNs: number | null;
  vcpus: number | null;
  /** KiB. */
  memoryKiB: number | null;
  maxMemoryKiB: number | null;
  /** Memory the VM's process really uses on the host, KiB. */
  rssKiB: number | null;
}

/** `virsh domstats --raw --state --cpu-total --balloon --vcpu`. */
export function parseDomstats(output: string): Map<string, DomainStats> {
  const domains = new Map<string, DomainStats>();
  let current: DomainStats | null = null;
  for (const line of output.split("\n")) {
    const header = /^Domain:\s*'?(.+?)'?\s*$/.exec(line.trim());
    if (header) {
      current = { state: null, cpuTimeNs: null, vcpus: null, memoryKiB: null, maxMemoryKiB: null, rssKiB: null };
      domains.set(header[1], current);
      continue;
    }
    const pair = /^\s*([\w.]+)=(\S+)/.exec(line);
    if (!pair || !current) continue;
    const value = Number(pair[2]);
    if (!Number.isFinite(value)) continue;
    switch (pair[1]) {
      case "state.state":
        current.state = value;
        break;
      case "cpu.time":
        current.cpuTimeNs = value;
        break;
      case "vcpu.current":
        current.vcpus = value;
        break;
      case "balloon.current":
        current.memoryKiB = value;
        break;
      case "balloon.maximum":
        current.maxMemoryKiB = value;
        break;
      case "balloon.rss":
        current.rssKiB = value;
        break;
    }
  }
  return domains;
}

/** `virsh list --all --title`: domains with their state and title (columns found by the header). */
export function parseVirshList(output: string): { id: string; name: string; stateLabel: string; title: string }[] {
  const lines = output.split("\n");
  const headerIndex = lines.findIndex((line) => /^\s*Id\s+Name\s+State/.test(line));
  if (headerIndex === -1) return [];
  const header = lines[headerIndex];
  const nameAt = header.indexOf("Name");
  const stateAt = header.indexOf("State");
  const titleAt = header.indexOf("Title");
  const out: { id: string; name: string; stateLabel: string; title: string }[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (/^-+$/.test(line.trim())) continue;
    // The table ends at the first blank line.
    if (!line.trim()) {
      if (out.length > 0) break;
      continue;
    }
    // Names have no spaces; the state can ("shut off").
    const [id, name] = line.trim().split(/\s+/);
    const end = titleAt > 0 ? titleAt : line.length;
    const stateLabel = line.slice(stateAt, end).trim() || line.slice(Math.max(nameAt + name.length, 0)).trim();
    const title = titleAt > 0 ? line.slice(titleAt).trim() : "";
    out.push({ id, name, stateLabel, title });
  }
  return out;
}

/** CPU use between two readings of a domain, as a share of its vCPUs (0-100). */
export function cpuPercent(before: { cpuTimeNs: number; at: number } | undefined, cpuTimeNs: number | null, at: number, vcpus: number | null): number | null {
  if (!before || cpuTimeNs === null || !vcpus || at <= before.at) return null;
  const used = (cpuTimeNs - before.cpuTimeNs) / ((at - before.at) * 1e6 * vcpus);
  return Math.max(0, Math.min(100, used * 100));
}

/** libvirt domains with their stats (CPU needs the previous reading). */
export function libvirtMachines(list: string, stats: string, previous: Map<string, { cpuTimeNs: number; at: number }>, at: number): VirtualMachine[] {
  const domstats = parseDomstats(stats);
  return parseVirshList(list).map((domain) => {
    const s = domstats.get(domain.name);
    const running = state(domain.stateLabel) === "running";
    return {
      key: domain.name,
      ref: domain.name,
      name: domain.title || domain.name,
      kind: "kvm" as const,
      node: null,
      state: state(domain.stateLabel),
      stateLabel: domain.stateLabel,
      cpus: s?.vcpus ?? null,
      cpuPercent: running ? cpuPercent(previous.get(domain.name), s?.cpuTimeNs ?? null, at, s?.vcpus ?? null) : null,
      memUsed: running && s?.rssKiB != null ? s.rssKiB * 1024 : null,
      memTotal: s?.maxMemoryKiB != null ? s.maxMemoryKiB * 1024 : null,
      diskUsed: null,
      diskTotal: null,
      uptimeSecs: null,
      template: false,
    };
  });
}

/** Why the hypervisor's command failed: not allowed, or its service is not running. */
export function vmAccessProblem(output: string): "permission" | "daemon" {
  const text = output.toLowerCase();
  if (text.includes("permission denied") || text.includes("authentication") || text.includes("not allowed") || text.includes("must be run as root")) return "permission";
  if (text.includes("failed to connect") || text.includes("no such file") || text.includes("connection refused") || text.includes("ipcc")) return "daemon";
  return "permission";
}

/** Single-quotes a value for a POSIX shell. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const NODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The command for an action. Proxmox goes through the cluster API from any node. */
export function actionCommand(hypervisor: Hypervisor, prefix: string, vm: VirtualMachine, action: VmAction): string {
  if (hypervisor === "proxmox") {
    if (!/^\d+$/.test(vm.ref) || !vm.node || !NODE.test(vm.node)) throw new Error(`unexpected machine: ${vm.key}`);
    return `${prefix} create /nodes/${vm.node}/${vm.kind}/${vm.ref}/status/${action}`;
  }
  const verb = { start: "start", shutdown: "shutdown", reboot: "reboot", stop: "destroy" }[action];
  return `${prefix} ${verb} ${shellQuote(vm.ref)}`;
}

/**
 * A console into the machine, typed in a new terminal tab: `pct enter` for a container on this
 * node, the serial console otherwise (it needs one configured in the guest). `null` when there is none.
 */
export function consoleCommand(hypervisor: Hypervisor, sudo: boolean, vm: VirtualMachine, thisNode: string): string | null {
  const s = sudo ? "sudo " : "";
  if (hypervisor === "libvirt") return `${s}virsh -c qemu:///system console ${shellQuote(vm.ref)}`;
  if (vm.node !== thisNode || !/^\d+$/.test(vm.ref)) return null;
  return vm.kind === "lxc" ? `${s}pct enter ${vm.ref}` : `${s}qm terminal ${vm.ref}`;
}
