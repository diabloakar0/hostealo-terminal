#!/usr/bin/env node
// Adds the macOS app to a release's latest.json (the file the app's updater reads). CI builds
// Windows and Linux and writes latest.json; the Mac app is built, signed and notarized locally,
// so its entry is added here before latest.json goes back up to the release.
//
//   node scripts/latest-json-macos.mjs latest.json <url of the .app.tar.gz> <its .sig file>
//
// One universal app serves both Apple Silicon and Intel Macs.
import { readFileSync, writeFileSync } from "node:fs";

const [file, url, sigFile] = process.argv.slice(2);
if (!file || !url || !sigFile) {
  console.error("usage: latest-json-macos.mjs <latest.json> <app.tar.gz url> <sig file>");
  process.exit(1);
}
const latest = JSON.parse(readFileSync(file, "utf8"));
const entry = { signature: readFileSync(sigFile, "utf8").trim(), url };
latest.platforms = { ...latest.platforms, "darwin-aarch64": entry, "darwin-x86_64": entry };
writeFileSync(file, JSON.stringify(latest, null, 2) + "\n");
console.log(`${file}: ${Object.keys(latest.platforms).sort().join(", ")}`);
