/**
 * Commands worth a second look before they run: they destroy data, cut the connection or take
 * the machine down. The assistant's "Run" asks for confirmation when a command matches.
 */
const PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, // rm -rf, rm -r, rm -f
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*\bof=/,
  /\b(wipefs|shred|fdisk|sfdisk|parted|gdisk)\b/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\binit\s+[06]\b/,
  /\bsystemctl\s+(stop|disable|mask|isolate|reboot|poweroff|halt)\b/,
  /\b(iptables|ip6tables)\s+(-F|--flush|-P\s+\w+\s+DROP)/,
  /\bufw\s+(enable|reset|default\s+deny)\b/,
  /\bnft\s+flush\b/,
  /\b(apt|apt-get|yum|dnf|zypper|pacman)\s+(remove|purge|autoremove|erase|-R)/,
  /\bchmod\s+(-R\s+)?[0-7]*777\b/,
  /\bchown\s+-R\b/,
  /\b(DROP|TRUNCATE)\s+(DATABASE|TABLE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i,
  /\bgit\s+(push\s+.*(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f)/,
  /\bdocker\s+(system|volume|image|container)\s+prune\b/,
  /\bkill\s+-9\s+(-1|1)\b|\bkillall\b/,
  />\s*\/dev\/(sd|nvme|vd|xvd)\w*/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /\b(Remove-Item\b.*-Recurse|Format-Volume|Clear-Disk|Stop-Computer|Restart-Computer)\b/i,
];

export function isDangerousCommand(command: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(command));
}
