import { useEffect, useMemo, useState } from "react";
import type { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { CodeMirror } from "../editor/CodeMirror";
import { codeExtensions } from "../editor/setup";
import { useWorkspace, type Buffer } from "../state/workspace";
import { LARGE_FILE_BYTES } from "./MarkdownEditor";
import { lineNumbers } from "@codemirror/view";
import { Notice } from "../design-system/components";
import { DesignSystemScope } from "../views/DesignSystemScope";
import "./sourceControls.css";
import "./documentStates.css";
import { useSettings } from "../state/settings";

/** Loads the CodeMirror language for a file name (bundled locally, loaded on demand). */
function useLanguage(path: string): LanguageSupport | null | undefined {
  const [lang, setLang] = useState<LanguageSupport | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setLang(undefined);
    const name = path.split("/").pop() ?? path;
    const desc = languages.find(
      (l) => l.extensions.some((e) => name.toLowerCase().endsWith(`.${e}`)) || l.filename?.test(name),
    );
    if (!desc) setLang(null);
    else
      desc.load().then(
        (l) => live && setLang(l),
        () => live && setLang(null),
      );
    return () => {
      live = false;
    };
  }, [path]);
  return lang;
}

/** Syntax-highlighted editor for code, JSON, YAML, plain text and HTML source. */
export function CodeEditor({ buffer, wrap }: { buffer: Buffer; wrap?: boolean }) {
  const path = buffer.path;
  const lang = useLanguage(path);
  const readOnly = (buffer.content?.length ?? 0) > LARGE_FILE_BYTES;
  const numbers = useSettings((s) => s.sourceLineNumbers);
  const extensions = useMemo(
    () =>
      lang === undefined
        ? null
        : [
            codeExtensions(lang, (t) => useWorkspace.getState().edit(path, t), readOnly, wrap),
            numbers ? lineNumbers() : [],
          ],
    [lang, path, readOnly, wrap, numbers],
  );
  if (!extensions)
    return (
      <DesignSystemScope className="document-state">
        <Notice>Loading source editor…</Notice>
      </DesignSystemScope>
    );
  return (
    <DesignSystemScope className="code-scroll source-editor-controls" role="region" aria-label="Source editor controls">
      {readOnly && <Notice tone="warning">This file is larger than 5 MB and opened read-only.</Notice>}
      <CodeMirror className="code-editor" doc={buffer.content ?? ""} version={buffer.version} extensions={extensions} />
    </DesignSystemScope>
  );
}
