import { describe, expect, it } from "vitest";

import { frequentHosts, sortHosts, type Usage } from "./hostSort";
import type { Host } from "./ipc";

const host = (id: string, name: string, os: string | null = null, protocol: Host["protocol"] = "ssh") =>
  ({ id, name, protocol, os: os ? { id: os.toLowerCase(), name: os } : null }) as Host;

const hosts = [host("a", "web-10", "Ubuntu"), host("b", "db", "Debian"), host("c", "web-2"), host("d", "win", null, "rdp")];
const usage: Usage = { a: { last: 300, count: 2 }, b: { last: 100, count: 9 }, d: { last: 500, count: 2 } };
const names = (list: Host[]) => list.map((h) => h.name);

describe("host order", () => {
  it("keeps the order they were added in, or reverses it", () => {
    expect(names(sortHosts(hosts, "added", usage))).toEqual(["web-10", "db", "web-2", "win"]);
    expect(names(sortHosts(hosts, "addedDesc", usage))).toEqual(["win", "web-2", "db", "web-10"]);
  });

  it("sorts names the way people read them", () => {
    expect(names(sortHosts(hosts, "name", usage))).toEqual(["db", "web-2", "web-10", "win"]);
    expect(names(sortHosts(hosts, "nameDesc", usage))).toEqual(["win", "web-10", "web-2", "db"]);
  });

  it("groups by system, unknown ones last", () => {
    expect(names(sortHosts(hosts, "os", usage))).toEqual(["db", "web-10", "win", "web-2"]);
  });

  it("puts the latest used first and the never used last", () => {
    expect(names(sortHosts(hosts, "recent", usage))).toEqual(["win", "web-10", "db", "web-2"]);
  });

  it("puts the most used first, the latest breaking ties", () => {
    expect(names(sortHosts(hosts, "frequent", usage))).toEqual(["db", "win", "web-10", "web-2"]);
  });

  it("does not change the list it was given", () => {
    sortHosts(hosts, "name", usage);
    expect(names(hosts)).toEqual(["web-10", "db", "web-2", "win"]);
  });
});

describe("usual servers", () => {
  it("are the ones used at least twice, when the list is long enough", () => {
    const many = [...hosts, host("e", "e"), host("f", "f")];
    expect(names(frequentHosts(many, { ...usage, e: { last: 1, count: 1 } }))).toEqual(["db", "win", "web-10"]);
    expect(frequentHosts(hosts, usage)).toEqual([]);
  });
});
