/**
 * Operating system logos, keyed by the ids the backend detects (src-tauri/src/ssh/os.rs).
 * Logos from Simple Icons (CC0); the marks themselves belong to their owners and are only used to
 * say which system a server runs. Windows has no Simple Icons entry, so it gets a neutral
 * four-pane glyph drawn here.
 */
import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siManjaro,
  siNixos,
  siOpenbsd,
  siOpensuse,
  siPopos,
  siProxmox,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siSuse,
  siUbuntu,
} from "simple-icons";

export interface OsIcon {
  title: string;
  /** SVG path on a 24×24 box. */
  path: string;
  /** Brand colour, without `#`. */
  hex: string;
}

const icon = ({ title, path, hex }: OsIcon): OsIcon => ({ title, path, hex });

const WINDOWS: OsIcon = {
  title: "Windows",
  path: "M2 2h9.5v9.5H2zM12.5 2H22v9.5h-9.5zM2 12.5h9.5V22H2zM12.5 12.5H22V22h-9.5z",
  hex: "0078D4",
};

/** A terminal prompt for Unix systems without a logo of their own. */
const UNIX: OsIcon = {
  title: "Unix",
  path: "M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v14h16V5zm2.3 3.3 1.4-1.4L12.8 12l-5.1 5.1-1.4-1.4L10 12zM12 15h6v2h-6z",
  hex: "71717A",
};

export const OS_ICONS: Record<string, OsIcon> = {
  ubuntu: icon(siUbuntu),
  debian: icon(siDebian),
  raspberrypi: icon(siRaspberrypi),
  linuxmint: icon(siLinuxmint),
  popos: icon(siPopos),
  kali: icon(siKalilinux),
  centos: icon(siCentos),
  rocky: icon(siRockylinux),
  almalinux: icon(siAlmalinux),
  rhel: icon(siRedhat),
  fedora: icon(siFedora),
  arch: icon(siArchlinux),
  manjaro: icon(siManjaro),
  alpine: icon(siAlpinelinux),
  opensuse: icon(siOpensuse),
  suse: icon(siSuse),
  gentoo: icon(siGentoo),
  nixos: icon(siNixos),
  proxmox: icon(siProxmox),
  linux: icon(siLinux),
  freebsd: icon(siFreebsd),
  openbsd: icon(siOpenbsd),
  macos: { ...icon(siApple), title: "macOS" },
  windows: WINDOWS,
  unix: UNIX,
};

export const osIcon = (id: string | null | undefined): OsIcon | null => (id ? (OS_ICONS[id] ?? OS_ICONS.linux) : null);

/** Brand colours too dark to see on a dark background (Apple, AlmaLinux, CentOS...). */
export function isDarkBrand(hex: string): boolean {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.15;
}
