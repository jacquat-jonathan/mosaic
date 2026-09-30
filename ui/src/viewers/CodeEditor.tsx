import { useEffect, useMemo, useState } from "react";
import type { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { CodeMirror } from "../editor/CodeMirror";
import { codeExtensions } from "../editor/setup";
import { useWorkspace, type Buffer } from "../state/workspace";
import { LARGE_FILE_BYTES } from "./MarkdownEditor";

/** Loads the CodeMirror language for a file name (bundled locally, loaded on demand). */
function useLanguage(path: string): LanguageSupport | null | undefined {
  const [lang, setLang] = useState<LanguageSupport | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const name = path.split("/").pop() ?? path;
    const desc = languages.find((l) => l.extensions.some((e) => name.toLowerCase().endsWith(`.${e}`)) || l.filename?.test(name));
    if (!desc) setLang(null);
    else desc.load().then((l) => live && setLang(l), () => live && setLang(null));
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
  const extensions = useMemo(
    () => (lang === undefined ? null : codeExtensions(lang, (t) => useWorkspace.getState().edit(path, t), readOnly, wrap)),
    [lang, path, readOnly, wrap],
  );
  if (!extensions) return null;
  return (
    <div className="code-scroll">
      {readOnly && <div className="notice warn"><span>This file is larger than 5 MB and opened read-only.</span></div>}
      <CodeMirror className="code-editor" doc={buffer.content ?? ""} version={buffer.version} extensions={extensions} />
    </div>
  );
}
