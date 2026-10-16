import { describe, expect, it } from "vitest";

import { actionCommand, consoleCommand, cpuPercent, libvirtMachines, parseDomstats, parseProxmox, parseVirshList, shellQuote, vmAccessProblem } from "./virt";

const PVESH = JSON.stringify([
  { id: "qemu/101", type: "qemu", vmid: 101, name: "web", node: "pve1", status: "running", cpu: 0.125, maxcpu: 4, mem: 2147483648, maxmem: 4294967296, disk: 0, maxdisk: 34359738368, uptime: 3600, template: 0 },
  { id: "lxc/102", type: "lxc", vmid: 102, name: "dns", node: "pve2", status: "stopped", cpu: 0, maxcpu: 1, mem: 0, maxmem: 536870912, disk: 1073741824, maxdisk: 8589934592, uptime: 0, template: 0 },
  { id: "qemu/9000", type: "qemu", vmid: 9000, name: "ubuntu-tpl", node: "pve1", status: "stopped", maxcpu: 2, maxmem: 2147483648, template: 1 },
  { id: "storage/pve1/local", type: "storage", node: "pve1" },
]);

const LIST = `
 Id   Name           State      Title
------------------------------------------------
 1    vps-1201       running    tienda.example.com
 3    vps-1202       paused
 -    vps-1300       shut off   correo.example.com
`;

const STATS = `Domain: 'vps-1201'
  state.state=1
  state.reason=1
  cpu.time=12000000000
  balloon.current=4194304
  balloon.maximum=4194304
  balloon.rss=1048576
  vcpu.current=2
  vcpu.maximum=2

Domain: 'vps-1300'
  state.state=5
  balloon.maximum=2097152
`;

describe("virtual machines", () => {
  it("reads a Proxmox cluster: VMs and containers, templates last, no storage rows", () => {
    const vms = parseProxmox(PVESH);
    expect(vms.map((vm) => [vm.key, vm.state, vm.node, vm.template])).toEqual([
      ["qemu/101", "running", "pve1", false],
      ["lxc/102", "stopped", "pve2", false],
      ["qemu/9000", "stopped", "pve1", true],
    ]);
    expect(vms[0].cpuPercent).toBe(12.5);
    expect(vms[0].diskUsed).toBeNull();
    expect(vms[1].diskUsed).toBe(1073741824);
    expect(parseProxmox("not json")).toEqual([]);
  });

  it("reads virsh's table, including two-word states and titles", () => {
    expect(parseVirshList(LIST)).toEqual([
      { id: "1", name: "vps-1201", stateLabel: "running", title: "tienda.example.com" },
      { id: "3", name: "vps-1202", stateLabel: "paused", title: "" },
      { id: "-", name: "vps-1300", stateLabel: "shut off", title: "correo.example.com" },
    ]);
    expect(parseVirshList(" Id   Name     State\n----------------------\n 2    db       running\n")).toEqual([{ id: "2", name: "db", stateLabel: "running", title: "" }]);
  });

  it("reads domstats and works out CPU from two readings", () => {
    const stats = parseDomstats(STATS);
    expect(stats.get("vps-1201")).toMatchObject({ state: 1, cpuTimeNs: 12e9, vcpus: 2, rssKiB: 1048576 });
    // 1 s of CPU time over 1 s with 2 vCPUs = 50 %.
    expect(cpuPercent({ cpuTimeNs: 11e9, at: 0 }, 12e9, 1000, 2)).toBe(50);
    expect(cpuPercent(undefined, 12e9, 1000, 2)).toBeNull();
    const vms = libvirtMachines(LIST, STATS, new Map([["vps-1201", { cpuTimeNs: 11e9, at: 0 }]]), 1000);
    expect(vms.map((vm) => [vm.name, vm.state, vm.cpuPercent, vm.memUsed])).toEqual([
      ["tienda.example.com", "running", 50, 1073741824],
      ["vps-1202", "paused", null, null],
      ["correo.example.com", "stopped", null, null],
    ]);
  });

  it("reads virsh 12's real output (libvirt test driver, a domain just destroyed)", () => {
    const real = "Domain 'test' destroyed\n\n Id   Name   State      Title\n-------------------------------\n -    test   shut off   \n\nDomain: 'test'\n  state.state=5\n  state.reason=2\n";
    const vms = libvirtMachines(real, real, new Map(), 0);
    expect(vms.map((vm) => [vm.name, vm.state, vm.stateLabel])).toEqual([["test", "stopped", "shut off"]]);
  });

  it("tells a stopped libvirt from a missing permission (real messages)", () => {
    expect(vmAccessProblem("error: failed to connect to the hypervisor\nerror: Failed to connect socket to '/var/run/libvirt/virtqemud-sock': No such file or directory")).toBe("daemon");
    expect(vmAccessProblem("error: authentication unavailable: no polkit agent available to authenticate action 'org.libvirt.unix.manage'")).toBe("permission");
    expect(vmAccessProblem("ipcc_send_rec[1] failed: Unknown error -1")).toBe("daemon");
  });

  it("builds safe commands", () => {
    const [web] = parseProxmox(PVESH);
    expect(actionCommand("proxmox", "pvesh", web, "shutdown")).toBe("pvesh create /nodes/pve1/qemu/101/status/shutdown");
    expect(() => actionCommand("proxmox", "pvesh", { ...web, node: "pve1; rm -rf /" }, "stop")).toThrow();
    const [kvm] = libvirtMachines(LIST, STATS, new Map(), 0);
    expect(actionCommand("libvirt", "virsh -c qemu:///system", kvm, "stop")).toBe("virsh -c qemu:///system destroy 'vps-1201'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(consoleCommand("proxmox", false, web, "pve1")).toBe("qm terminal 101");
    expect(consoleCommand("proxmox", true, { ...web, kind: "lxc" }, "pve1")).toBe("sudo pct enter 101");
    expect(consoleCommand("proxmox", false, web, "pve2")).toBeNull();
  });
});
