import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileCode, LoaderCircle, Save, TriangleAlert, WrapText, X } from "lucide-react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { cn } from "@hostealo/ui/cn";

import { detectLanguage, LANGUAGES, loadLanguage, type LanguageId } from "../lib/editorLanguages";
import { TEXT_BINARY, TEXT_CHANGED, TEXT_TOO_LARGE, type TextEncoding, type TextFile } from "../lib/ipc";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/Button";

/** Where the file lives and how to read and save it (SFTP, FTP or this computer). */
export interface EditorSource {
  path: string;
  /** The server's name, or this computer's. */
  where: string;
  read: () => Promise<TextFile>;
  write: (content: string, encoding: TextEncoding, expectedModified: number | null) => Promise<number | null>;
}

const WRAP_KEY = "hostealo-terminal:editor-wrap";

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === "true";
  } catch {
    return false;
  }
}

/** The app's own colours, so the editor follows the light and dark themes. */
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg-card)", color: "var(--text-primary)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "var(--bg-deep)", color: "var(--text-muted)", borderRight: "1px solid var(--bg-border)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--muted) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--muted)", color: "var(--text-secondary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--accent-glow) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--amber) 22%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--amber) 30%, transparent)", outline: "1px solid var(--amber)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-glow)", outline: "1px solid var(--accent)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--muted)", border: "none", color: "var(--text-secondary)" },
  ".cm-panels": { backgroundColor: "var(--bg-deep)", color: "var(--text-primary)", borderColor: "var(--bg-border)" },
  ".cm-panel input, .cm-panel button": { color: "var(--text-primary)", backgroundColor: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: "6px" },
  ".cm-tooltip": { backgroundColor: "var(--dropdown-bg)", border: "1px solid var(--bg-border)" },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: "var(--purple)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--green)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--orange)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--text-muted)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], color: "var(--blue)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--cyan)" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: "var(--blue)" },
  { tag: [tags.tagName, tags.heading], color: "var(--red)", fontWeight: "600" },
  { tag: [tags.meta, tags.processingInstruction, tags.annotation, tags.macroName], color: "var(--amber)" },
  { tag: [tags.variableName, tags.self], color: "var(--text-primary)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "var(--text-secondary)" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: [tags.inserted], color: "var(--green)" },
  { tag: [tags.deleted, tags.invalid], color: "var(--red)" },
]);

const ENCODING_LABEL: Record<TextEncoding, string> = { "utf-8": "UTF-8", "utf-8-bom": "UTF-8 BOM", latin1: "Latin-1" };

/** A text file open for editing, over the file browser: syntax colours for its language, Ctrl+S to save. */
export default function FileEditor({ source, onClose, onSaved }: { source: EditorSource; onClose: () => void; onSaved?: () => void }) {
  const { t } = useTranslation();
  const name = source.path.split(/[\\/]/).pop() ?? source.path;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  /** The text as last saved, to tell whether there are changes. */
  const savedDoc = useRef<Text | null>(null);
  const meta = useRef<{ encoding: TextEncoding; modified: number | null; eol: "\n" | "\r\n" }>({ encoding: "utf-8", modified: null, eol: "\n" });

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [languageId, setLanguageId] = useState<LanguageId>("plain");
  const [wrap, setWrap] = useState(readWrap);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  const save = async (force = false) => {
    const view = viewRef.current;
    if (!view || saving) return;
    const doc = view.state.doc;
    const { encoding, modified, eol } = meta.current;
    // The editor works with "\n"; the file gets back the line endings it had.
    const content = eol === "\r\n" ? doc.toString().replace(/\n/g, "\r\n") : doc.toString();
    setSaving(true);
    setSaveError(null);
    try {
      meta.current.modified = await source.write(content, encoding, force ? null : modified);
      savedDoc.current = doc;
      setDirty(!view.state.doc.eq(doc));
      onSaved?.();
    } catch (e) {
      if (String(e) === TEXT_CHANGED) setConflict(true);
      else setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Load the file and build the editor once.
  useEffect(() => {
    let disposed = false;
    source
      .read()
      .then(async (file) => {
        if (disposed || !hostRef.current) return;
        meta.current = { encoding: file.encoding, modified: file.modified, eol: file.content.includes("\r\n") ? "\r\n" : "\n" };
        const detected = detectLanguage(source.path, file.content);
        const syntax = await loadLanguage(detected).catch(() => []);
        if (disposed || !hostRef.current) return;
        const state = EditorState.create({
          doc: file.content,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            foldGutter(),
            highlightSpecialChars(),
            history(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            rectangularSelection(),
            crosshairCursor(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            syntaxHighlighting(highlight),
            theme,
            language.current.of(syntax),
            wrapping.current.of(readWrap() ? EditorView.lineWrapping : []),
            keymap.of([
              { key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) },
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...searchKeymap,
              ...historyKeymap,
              ...foldKeymap,
              indentWithTab,
            ]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) setDirty(!(savedDoc.current && update.state.doc.eq(savedDoc.current)));
              if (update.selectionSet || update.docChanged) {
                const head = update.state.selection.main.head;
                const line = update.state.doc.lineAt(head);
                setCursor({ line: line.number, col: head - line.from + 1 });
              }
            }),
          ],
        });
        savedDoc.current = state.doc;
        viewRef.current = new EditorView({ state, parent: hostRef.current });
        viewRef.current.focus();
        setLanguageId(detected);
        setLoaded(true);
      })
      .catch((e) => !disposed && setLoadError(String(e)));
    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // The file is fixed for the editor's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeLanguage = (id: LanguageId) => {
    setLanguageId(id);
    void loadLanguage(id).then((syntax) => viewRef.current?.dispatch({ effects: language.current.reconfigure(syntax) }));
  };

  const toggleWrap = () => {
    const next = !wrap;
    setWrap(next);
    try {
      localStorage.setItem(WRAP_KEY, String(next));
    } catch {
      // Not remembered, still applies now.
    }
    viewRef.current?.dispatch({ effects: wrapping.current.reconfigure(next ? EditorView.lineWrapping : []) });
  };

  const close = () => (dirty ? setConfirmClose(true) : onClose());

  const loadMessage =
    loadError === TEXT_BINARY ? t("editor.binary") : loadError === TEXT_TOO_LARGE ? t("editor.tooLarge") : loadError ? t("editor.loadFailed", { error: loadError }) : null;

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-card"
      role="dialog"
      aria-label={t("editor.title", { name })}
      // Ctrl+S with the focus on the toolbar; the editor's own Ctrl+S has already handled it otherwise.
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !e.defaultPrevented) {
          e.preventDefault();
          if (dirty) void save();
        }
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-deep pl-3 pr-1.5">
        <FileCode className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 truncate text-sm">
          <span className="font-medium text-fg">{name}</span>
          <span className="ml-2 font-mono text-xs text-fg-muted" title={source.path}>
            {source.path}
          </span>
        </span>
        {dirty && <span className="size-2 shrink-0 rounded-full bg-amber" title={t("editor.unsaved")} aria-label={t("editor.unsaved")} />}
        <div className="flex-1" />
        {loaded && (
          <>
            <select
              value={languageId}
              onChange={(e) => changeLanguage(e.target.value as LanguageId)}
              title={t("editor.language")}
              aria-label={t("editor.language")}
              className="h-7 cursor-pointer rounded-btn-sm border border-input-border bg-input px-1.5 text-xs text-fg outline-none"
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.id === "plain" ? t("editor.plainText") : l.label}
                </option>
              ))}
            </select>
            <Button variant="ghost" size="icon" onClick={toggleWrap} title={t("editor.wrap")} aria-label={t("editor.wrap")} aria-pressed={wrap}>
              <WrapText className={cn("size-4", wrap && "text-accent")} />
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || saving} title={t("editor.saveHint")}>
              {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {t("common.save")}
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon" onClick={close} title={t("common.close")} aria-label={t("common.close")}>
          <X className="size-4" />
        </Button>
      </header>

      {saveError && (
        <p className="flex shrink-0 items-center gap-2 border-b border-border bg-red/10 px-3 py-1.5 text-xs text-red">
          <TriangleAlert className="size-3.5 shrink-0" />
          {t("editor.saveFailed", { error: saveError })}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />
        {!loaded && (
          <div className="absolute inset-0 grid place-items-center bg-card">
            {loadMessage ? (
              <div className="max-w-md px-6 text-center">
                <TriangleAlert className="mx-auto size-6 text-amber" />
                <p className="mt-2 text-sm text-fg-secondary">{loadMessage}</p>
                <Button className="mt-4" onClick={onClose}>
                  {t("common.close")}
                </Button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-fg-muted">
                <LoaderCircle className="size-4 animate-spin" />
                {t("editor.loading")}
              </p>
            )}
          </div>
        )}
      </div>

      {loaded && (
        <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-deep px-3 text-[11px] tabular-nums text-fg-muted">
          <span>{t("editor.position", cursor)}</span>
          <span>{ENCODING_LABEL[meta.current.encoding]}</span>
          <span>{meta.current.eol === "\r\n" ? "CRLF" : "LF"}</span>
          {meta.current.encoding === "latin1" && <span className="text-amber">{t("editor.latin1Hint")}</span>}
          <div className="flex-1" />
          <span className="truncate">{source.where}</span>
        </footer>
      )}

      {conflict && (
        <ConfirmDialog
          title={t("editor.conflictTitle")}
          confirmLabel={t("editor.overwrite")}
          icon={<TriangleAlert className="size-4" />}
          onConfirm={() => save(true)}
          onClose={() => setConflict(false)}
        >
          {t("editor.conflictBody", { name })}
        </ConfirmDialog>
      )}
      {confirmClose && (
        <ConfirmDialog
          title={t("editor.discardTitle")}
          confirmLabel={t("editor.discard")}
          icon={<TriangleAlert className="size-4" />}
          onConfirm={onClose}
          onClose={() => setConfirmClose(false)}
        >
          {t("editor.discardBody", { name })}
        </ConfirmDialog>
      )}
    </div>
  );
}
