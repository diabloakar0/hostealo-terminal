import { beforeEach, describe, expect, it } from "vitest";

import type { ResourceSnapshot } from "../lib/ipc";
import { step, useAlerts } from "./alerts";

const thresholds = { disk: 90, memory: 90, cpu: 90 };

const snapshot = (cpu: number, memPct: number, diskPct: number): ResourceSnapshot => ({
  hostname: "web-01",
  os: "Ubuntu",
  cpuPercent: cpu,
  cpuCount: 4,
  memUsed: memPct,
  memTotal: 100,
  swapUsed: 0,
  swapTotal: 0,
  disks: [{ mount: "/", used: diskPct, total: 100 }],
  netRxBps: 0,
  netTxBps: 0,
  load: [0.1, 0.1, 0.1],
  uptimeSecs: 100,
});

describe("alert rules", () => {
  beforeEach(() => useAlerts.setState({ alerts: [], conditions: {}, toasts: [] }));

  it("a full disk fires at once, and only once until it clears", () => {
    const { observe } = useAlerts.getState();
    expect(observe("web", "web-01", snapshot(10, 10, 93), thresholds, 0).map((a) => [a.kind, a.detail, a.value])).toEqual([["disk", "/", 93]]);
    expect(observe("web", "web-01", snapshot(10, 10, 95), thresholds, 2_000)).toEqual([]);
    // 87 % is below 90 but within the hysteresis: still active.
    observe("web", "web-01", snapshot(10, 10, 87), thresholds, 4_000);
    expect(useAlerts.getState().alerts[0].active).toBe(true);
    observe("web", "web-01", snapshot(10, 10, 80), thresholds, 6_000);
    expect(useAlerts.getState().alerts[0].active).toBe(false);
    expect(observe("web", "web-01", snapshot(10, 10, 92), thresholds, 8_000)).toHaveLength(1);
  });

  it("CPU spikes are ignored; two minutes over the threshold fire", () => {
    const { observe } = useAlerts.getState();
    for (let t = 0; t < 110_000; t += 10_000) expect(observe("web", "web-01", snapshot(99, 10, 10), thresholds, t)).toEqual([]);
    // A dip resets the count.
    observe("web", "web-01", snapshot(20, 10, 10), thresholds, 115_000);
    expect(observe("web", "web-01", snapshot(99, 10, 10), thresholds, 120_000)).toEqual([]);
    expect(observe("web", "web-01", snapshot(99, 10, 10), thresholds, 240_000).map((a) => a.kind)).toEqual(["cpu"]);
  });

  it("memory needs one minute", () => {
    expect(step(undefined, { key: "memory", kind: "memory", detail: "", value: 95 }, 90, 0).event).toBeNull();
    const after = step({ since: 0, firing: false }, { key: "memory", kind: "memory", detail: "", value: 95 }, 90, 60_000);
    expect(after.event).toBe("fire");
  });

  it("a lost connection is resolved when it comes back, and forgetting a server ends its alerts", () => {
    const { connectionLost, connectionBack, observe, forget } = useAlerts.getState();
    connectionLost("web", "web-01", "connection reset");
    connectionBack("web");
    expect(useAlerts.getState().alerts.every((a) => !a.active)).toBe(true);
    observe("web", "web-01", snapshot(10, 10, 99), thresholds, 0);
    forget("web");
    expect(useAlerts.getState().alerts.filter((a) => a.active)).toEqual([]);
    expect(useAlerts.getState().conditions).toEqual({});
  });
});
