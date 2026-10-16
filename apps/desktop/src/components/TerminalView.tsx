import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hostealoDark, hostealoLight } from "@hostealo/ui/terminal-themes";
import { tintTerminalTheme } from "@hostealo/ui/host-colors";
import { cn } from "@hostealo/ui/cn";
import "@xterm/xterm/css/xterm.css";

import { OutputHighlighter } from "../lib/highlight";
import { createBackend, type SessionExit } from "../lib/sessions";
import { matchShortcut } from "../lib/shortcuts";
import { registerTerminal } from "../lib/terminals";
import { applyCtrl } from "../lib/touchKeys";
import { useHostAccent } from "../hooks/useHostColor";
import { useResolvedTheme } from "../hooks/usePreferences";
import { useSettings } from "../store/settings";
import { useTabs, type Tab } from "../store/tabs";

const FONT_FAMILY = '"Geist Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const dim = (text: string) => `\x1b[2m${text.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n`;
const red = (text: string) => `\x1b[31m${text.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n`;

interface TerminalViewProps {
  tab: Tab;
  active: boolean;
}

export function TerminalView({ tab, active }: TerminalViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const theme = useResolvedTheme();
  const accent = useHostAccent(tab.kind === "ssh" ? tab.hostId : null);
  const fontSize = useSettings((s) => s.fontSize);
  const termTheme = useMemo(() => {
    const base = theme === "light" ? hostealoLight : hostealoDark;
    return accent ? tintTerminalTheme(base, accent.color, theme) : base;
  }, [theme, accent?.color]);

  // Read through refs so a language change does not restart the session.
  const tRef = useRef(t);
  tRef.current = t;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useEffect(() => {
    const container = containerRef.current!;
    const settings = useSettings.getState();
    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: settings.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: document.documentElement.dataset.theme === "light" ? hostealoLight : hostealoDark,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey || event.ctrlKey) void openUrl(uri);
      }),
    );
    // App shortcuts are handled by the window listener in App; keep them away from the shell.
    term.attachCustomKeyEventHandler((e) => !matchShortcut(e));
    termRef.current = term;
    fitRef.current = fit;

    const backend = createBackend(tabRef.current);
    let disposed = false;
    let exited = false;

    const describeExit = ({ code, error }: SessionExit) => {
      const t = tRef.current;
      if (tabRef.current.kind === "ssh") {
        return error ? red(t("ssh.failed", { error })) : dim(t("ssh.closed"));
      }
      if (error) return red(t("terminal.spawnFailed", { error }));
      return dim(code === null ? t("terminal.exitedUnknown") : t("terminal.exited", { code }));
    };

    const start = () => {
      exited = false;
      // A fresh session starts with a fresh parser state (colours, alternate screen...).
      const highlighter = new OutputHighlighter();
      backend.start(term.cols, term.rows, {
        onData: (data) => term.write(highlighter.process(data, useSettings.getState().highlightOutput)),
        onInfo: (message) => term.write(dim(message)),
        onExit: (exit) => {
          if (disposed) return;
          exited = true;
          term.write(`\r\n${describeExit(exit)}`);
        },
      });
    };

    term.onData((data) => {
      if (exited) {
        if (data === "\r") {
          term.reset();
          start();
        }
        return;
      }
      backend.write(applyCtrl(data));
    });
    term.onResize(({ cols, rows }) => backend.resize(cols, rows));

    // The AI assistant reads the output and types commands, only when the user clicks.
    const unregister = registerTerminal(tabRef.current.id, {
      recentOutput: (count) => {
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let i = Math.max(0, buffer.length - count); i < buffer.length; i++) {
          const line = buffer.getLine(i);
          if (!line) continue;
          const text = line.translateToString(false);
          // Rows wrapped by the terminal width are one line of output.
          if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
          else lines.push(text);
        }
        return lines
          .map((line) => line.trimEnd())
          .join("\n")
          .replace(/\s+$/, "");
      },
      insert: (text) => {
        if (!exited) term.paste(text);
      },
      run: (text) => {
        if (!exited) backend.write(`${text.replace(/\r?\n/g, "\r")}\r`);
      },
      focus: () => term.focus(),
      send: (data) => {
        if (!exited) backend.write(data);
      },
      exec: (command, timeoutSecs) => backend.exec(command, timeoutSecs),
    });
    term.onTitleChange((title) => useTabs.getState().setTitle(tabRef.current.id, title));

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
      });
    });

    // xterm measures the cell size on open, so the font must be loaded first.
    void document.fonts.load(`${settings.fontSize}px "Geist Mono Variable"`).finally(() => {
      if (disposed) return;
      term.open(container);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // No WebGL: xterm falls back to the DOM renderer.
      }
      fit.fit();
      observer.observe(container);
      start();
      if (useTabs.getState().activeId === tabRef.current.id) term.focus();
    });

    return () => {
      disposed = true;
      unregister();
      cancelAnimationFrame(frame);
      observer.disconnect();
      backend.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tab.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = termTheme;
  }, [termTheme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    // Inactive tabs stay mounted (and keep their session) but are hidden; `invisible` keeps
    // their size so xterm can still measure itself.
    <div
      className={cn("absolute inset-0 py-2 pl-3 pr-1", !active && "invisible")}
      style={{ backgroundColor: termTheme.background }}
    >
      {/* Coloured hosts get a stripe along the top, on top of the tinted background. */}
      {accent && <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5" style={{ background: accent.hex }} />}
      <div ref={containerRef} className="size-full" />
    </div>
  );
}
