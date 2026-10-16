// Docker on a server, through plain `docker` commands over SSH: nothing to install, and the same
// permissions the user has in a terminal.

export interface Container {
  id: string;
  name: string;
  image: string;
  /** running, exited, restarting, paused, created, dead. */
  state: string;
  /** "Up 3 hours", "Exited (0) 2 days ago". */
  status: string;
  ports: string;
  /** Docker Compose project, if it belongs to one. */
  project: string | null;
}

export interface ContainerStats {
  cpu: string;
  memory: string;
  memoryPercent: number;
}

/** How Docker runs for this user: directly, through `sudo -n`, or not at all (and why). */
export type DockerAccess = { ok: true; prefix: string; version: string } | { ok: false; reason: "missing" | "permission" | "daemon"; detail: string };

/** A label value out of Docker's "k=v,k2=v2" list. */
function label(labels: string, key: string): string | null {
  for (const pair of labels.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (k === key) return rest.join("=") || null;
  }
  return null;
}

/** `docker ps --format '{{json .}}'`: one JSON object per line. Bad lines are skipped. */
export function parseContainers(output: string): Container[] {
  const containers: Container[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const raw = JSON.parse(line) as Record<string, string>;
      containers.push({
        id: raw.ID,
        name: (raw.Names ?? "").split(",")[0],
        image: raw.Image ?? "",
        state: (raw.State ?? "").toLowerCase(),
        status: raw.Status ?? "",
        ports: raw.Ports ?? "",
        project: label(raw.Labels ?? "", "com.docker.compose.project"),
      });
    } catch {
      // A truncated or foreign line.
    }
  }
  // Compose projects first (by name), then loose containers.
  return containers.sort(
    (a, b) => Number(a.project === null) - Number(b.project === null) || (a.project ?? "").localeCompare(b.project ?? "") || a.name.localeCompare(b.name),
  );
}

/** `docker stats --no-stream --format '{{json .}}'`, by container id (short or long). */
export function parseStats(output: string): Map<string, ContainerStats> {
  const stats = new Map<string, ContainerStats>();
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const raw = JSON.parse(line) as Record<string, string>;
      const value: ContainerStats = {
        cpu: raw.CPUPerc ?? "",
        memory: (raw.MemUsage ?? "").split("/")[0].trim(),
        memoryPercent: parseFloat(raw.MemPerc ?? "0") || 0,
      };
      if (raw.ID) stats.set(raw.ID, value);
      if (raw.Container) stats.set(raw.Container, value);
    } catch {
      // Skip.
    }
  }
  return stats;
}

/** Stats are keyed by short ids; containers carry long ones. */
export const statsFor = (stats: Map<string, ContainerStats>, id: string) => stats.get(id) ?? stats.get(id.slice(0, 12));

/** What a failed `docker version` means for the user. */
export function accessProblem(output: string, exitCode: number | null): "missing" | "permission" | "daemon" {
  const text = output.toLowerCase();
  if (exitCode === 127 || text.includes("not found")) return "missing";
  if (text.includes("permission denied")) return "permission";
  return "daemon";
}

/** Container ids are hex; anything else is refused before it reaches a shell. */
export function safeId(id: string): string {
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error(`unexpected container id: ${id}`);
  return id;
}

/** The command that opens a shell inside a container (bash when it has it). */
export const execShell = (prefix: string, container: Container) =>
  `${prefix} exec -it ${safeId(container.id)} sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'`;
