import { describe, expect, it } from "vitest";

import { accessProblem, execShell, parseContainers, parseStats, safeId, statsFor } from "./docker";

const PS = [
  '{"Command":"\\"docker-entrypoint.s…\\"","CreatedAt":"2026-10-01","ID":"a3f9c1e2b7d4aa","Image":"postgres:17","Labels":"com.docker.compose.project=shop,com.docker.compose.service=db","Names":"shop-db-1","Ports":"5432/tcp","State":"running","Status":"Up 12 days"}',
  '{"ID":"c4e2a9f1d3b8bb","Image":"nginx:1.27","Labels":"","Names":"edge","Ports":"0.0.0.0:80->80/tcp","State":"exited","Status":"Exited (0) 2 hours ago"}',
  '{"ID":"b81d0c4e9a12cc","Image":"redis:7","Labels":"com.docker.compose.project=shop","Names":"shop-cache-1","Ports":"","State":"running","Status":"Up 12 days"}',
  "WARNING: something on stderr mixed in",
  '{"ID": truncated',
].join("\n");

describe("docker", () => {
  it("reads containers grouped by compose project, skipping junk lines", () => {
    const containers = parseContainers(PS);
    expect(containers.map((c) => [c.project, c.name, c.state])).toEqual([
      ["shop", "shop-cache-1", "running"],
      ["shop", "shop-db-1", "running"],
      [null, "edge", "exited"],
    ]);
  });

  it("reads stats by short id", () => {
    const stats = parseStats('{"BlockIO":"0B / 0B","CPUPerc":"1.25%","Container":"a3f9c1e2b7d4","ID":"a3f9c1e2b7d4","MemPerc":"3.10%","MemUsage":"48.2MiB / 1.5GiB","Name":"shop-db-1"}');
    expect(statsFor(stats, "a3f9c1e2b7d4aa")).toEqual({ cpu: "1.25%", memory: "48.2MiB", memoryPercent: 3.1 });
  });

  it("explains why docker cannot be used", () => {
    expect(accessProblem("sh: 1: docker: not found", 127)).toBe("missing");
    expect(accessProblem("permission denied while trying to connect to the Docker daemon socket", 1)).toBe("permission");
    expect(accessProblem("Cannot connect to the Docker daemon at unix:///var/run/docker.sock", 1)).toBe("daemon");
  });

  it("only hex ids reach the shell", () => {
    expect(() => safeId("abc; rm -rf /")).toThrow();
    expect(execShell("docker", { id: "a3f9c1e2b7d4", name: "db", image: "", state: "running", status: "", ports: "", project: null })).toBe(
      "docker exec -it a3f9c1e2b7d4 sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'",
    );
  });
});
