// Which syntax the file editor uses for a file: from its name, its first line (#!) and, for
// generic config files, a look at what is inside. Each language loads only when first used.

import type { Extension } from "@codemirror/state";

export type LanguageId =
  | "plain"
  | "python"
  | "javascript"
  | "typescript"
  | "json"
  | "yaml"
  | "xml"
  | "html"
  | "css"
  | "sql"
  | "php"
  | "markdown"
  | "rust"
  | "go"
  | "java"
  | "cpp"
  | "shell"
  | "powershell"
  | "nginx"
  | "ini"
  | "toml"
  | "dockerfile"
  | "lua"
  | "perl"
  | "ruby"
  | "diff";

/** For the language picker, in the order shown. */
export const LANGUAGES: { id: LanguageId; label: string }[] = [
  { id: "plain", label: "Plain text" },
  { id: "shell", label: "Shell" },
  { id: "nginx", label: "nginx" },
  { id: "ini", label: "INI / conf" },
  { id: "yaml", label: "YAML" },
  { id: "json", label: "JSON" },
  { id: "toml", label: "TOML" },
  { id: "xml", label: "XML" },
  { id: "dockerfile", label: "Dockerfile" },
  { id: "python", label: "Python" },
  { id: "php", label: "PHP" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "sql", label: "SQL" },
  { id: "markdown", label: "Markdown" },
  { id: "powershell", label: "PowerShell" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "java", label: "Java" },
  { id: "cpp", label: "C / C++" },
  { id: "lua", label: "Lua" },
  { id: "perl", label: "Perl" },
  { id: "ruby", label: "Ruby" },
  { id: "diff", label: "Diff" },
];

const BY_EXTENSION: Record<string, LanguageId> = {
  txt: "plain", log: "plain", csv: "plain", tsv: "plain", text: "plain",
  py: "python", pyw: "python", pyi: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  yml: "yaml", yaml: "yaml",
  xml: "xml", svg: "xml", plist: "xml", xsd: "xml", xsl: "xml", xslt: "xml", csproj: "xml", config: "xml",
  html: "html", htm: "html", xhtml: "html", vue: "html",
  css: "css", scss: "css", less: "css",
  sql: "sql",
  php: "php", phtml: "php",
  md: "markdown", markdown: "markdown",
  rs: "rust",
  go: "go",
  java: "java", kt: "java", kts: "java",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell", fish: "shell",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  ini: "ini", cfg: "ini", cnf: "ini", properties: "ini", env: "ini", desktop: "ini",
  service: "ini", timer: "ini", socket: "ini", mount: "ini", target: "ini", path: "ini",
  conf: "ini",
  toml: "toml",
  lua: "lua",
  pl: "perl", pm: "perl",
  rb: "ruby",
  diff: "diff", patch: "diff",
};

/** Files known by their whole name. */
const BY_NAME: Record<string, LanguageId> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "shell",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_aliases": "shell",
  ".bash_logout": "shell",
  ".profile": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  ".env": "ini",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".htaccess": "shell",
  ".gitignore": "plain",
  ".dockerignore": "plain",
  "nginx.conf": "nginx",
  "fastcgi_params": "nginx",
  "mime.types": "nginx",
  crontab: "shell",
  hosts: "plain",
  "authorized_keys": "plain",
  "known_hosts": "plain",
  "requirements.txt": "plain",
  "pipfile": "toml",
  "cargo.lock": "toml",
};

const SHEBANG: [RegExp, LanguageId][] = [
  [/\b(ba|z|k|da)?sh\b/, "shell"],
  [/\bpython[0-9.]*\b/, "python"],
  [/\b(node|deno|bun)\b/, "javascript"],
  [/\bperl\b/, "perl"],
  [/\bruby\b/, "ruby"],
  [/\bphp\b/, "php"],
  [/\bpwsh\b/, "powershell"],
  [/\blua\b/, "lua"],
];

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!.toLowerCase();
}

function extension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  // ".bashrc" has no extension, it is the name.
  return dot > 0 ? name.slice(dot + 1) : null;
}

/** nginx's `server { … }` / `location` blocks, versus INI sections and `key = value` lines. */
function looksLikeNginx(content: string): boolean {
  return /^\s*(server|location|upstream|http|events|map|stream)\b[^\n{;]*\{/m.test(content) || /^\s*(listen|server_name|proxy_pass|root|include)\s+[^\n]*;\s*$/m.test(content);
}

/** Apache-style `<VirtualHost>` / `<Directory>` blocks with `Directive value` lines. */
function looksLikeApache(content: string): boolean {
  return /^\s*<\/?(VirtualHost|Directory|Location|IfModule|Files)\b/im.test(content);
}

/** The language for a file, from its path and (for config files without a clear name) its text. */
export function detectLanguage(path: string, content = ""): LanguageId {
  const name = baseName(path);
  const byName = BY_NAME[name];
  if (byName) return byName;
  // nginx keeps its sites in sites-available / conf.d, often without .conf.
  if (/[\\/](nginx|sites-(available|enabled))[\\/]/i.test(path) && looksLikeNginx(content)) return "nginx";

  const ext = extension(name);
  const byExtension = ext ? BY_EXTENSION[ext] : undefined;
  if (byExtension === "ini" && (ext === "conf" || ext === "cfg" || ext === "cnf")) {
    if (looksLikeNginx(content)) return "nginx";
    if (looksLikeApache(content)) return "shell";
  }
  if (byExtension) return byExtension;

  return sniff(content);
}

/** A file whose name says nothing: what its text looks like. */
function sniff(content: string): LanguageId {
  const text = content.trimStart();
  const newline = text.indexOf("\n");
  const firstLine = (newline < 0 ? text : text.slice(0, newline)).trim();
  if (firstLine.startsWith("#!")) {
    for (const [pattern, language] of SHEBANG) if (pattern.test(firstLine)) return language;
  }
  if (/^<\?php\b/i.test(text)) return "php";
  if (/^<!doctype html|^<html\b/i.test(text)) return "html";
  if (/^<\?xml\b/i.test(text) || (/^<[A-Za-z!]/.test(text) && text.trimEnd().endsWith(">"))) return "xml";
  if (/^[{[]/.test(text) && text.length < 2_000_000) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // Not JSON after all.
    }
  }
  if (looksLikeNginx(content)) return "nginx";
  if (looksLikeApache(content)) return "shell";
  if (/^\s*\[[^\]\n]+\]\s*$/m.test(content) && /^\s*[\w.-]+\s*[=:]/m.test(content)) return "ini";
  // YAML: a document marker, or several `key: value` / `- item` lines.
  const yamlLines = content.split("\n").filter((line) => /^\s*([\w.-]+:(\s|$)|- )/.test(line)).length;
  if (text.startsWith("---") || yamlLines >= 3) return "yaml";
  if ((content.match(/^\s*[\w.-]+\s*=/gm) ?? []).length >= 2) return "ini";
  if ((content.match(/^\s*#/gm) ?? []).length >= 2) return "shell";
  return "plain";
}

/** What a double click must not try to edit: archives, media, programs, documents. */
const BINARY_EXTENSIONS = new Set([
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "lz4", "lzma", "cab", "iso", "img", "dmg", "vhd", "vhdx", "qcow2", "vmdk",
  "deb", "rpm", "apk", "msi", "exe", "dll", "so", "dylib", "bin", "o", "a", "lib", "class", "jar", "war", "pyc", "wasm",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "avif", "psd",
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "mp4", "mkv", "avi", "mov", "webm", "wmv",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3", "mdb", "frm", "ibd", "myd", "myi", "rdb", "dump",
  "p12", "pfx", "der", "jks", "keystore", "kdbx",
]);

/**
 * Whether a double click opens the file in the editor. Everything does except files that are
 * plainly not text; the editor itself refuses (and offers a download) anything else that is binary.
 */
export function isEditableName(path: string): boolean {
  const ext = extension(baseName(path));
  return ext === null || !BINARY_EXTENSIONS.has(ext);
}

/** The syntax highlighting for a language (loaded on first use). */
export async function loadLanguage(id: LanguageId): Promise<Extension> {
  const legacy = async (load: () => Promise<Parameters<typeof import("@codemirror/language").StreamLanguage.define>[0]>) => {
    const [{ StreamLanguage }, mode] = await Promise.all([import("@codemirror/language"), load()]);
    return StreamLanguage.define(mode);
  };
  switch (id) {
    case "plain":
      return [];
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "shell":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "powershell":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell);
    case "nginx":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx);
    case "ini":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties);
    case "toml":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml);
    case "dockerfile":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
    case "lua":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua);
    case "perl":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/perl")).perl);
    case "ruby":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby);
    case "diff":
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/diff")).diff);
  }
}
