import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { Buffer } from "../state/workspace";
import { fileUrl } from "../ipc/api";
import { parentOf } from "../state/vault";
import { CodeEditor } from "./CodeEditor";
import { Segmented, Toolbar } from "./Toolbar";

/** Pages opted in to scripts this session (never persisted: it's an explicit, per-file choice). */
const scriptsAllowed = new Set<string>();

const isLocal = (url: string) => !!url && !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(url);

function resolveRelative(dir: string, rel: string): string {
  const parts = dir.split("/").filter(Boolean);
  for (const seg of decodeURI(rel.split(/[?#]/)[0]).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Builds the sandboxed document: a CSP that blocks all network access, and local images/stylesheets
 * rewritten to vault file URLs.
 */
async function sandboxedDoc(path: string, html: string, scripts: boolean): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const dir = parentOf(path);
  const rewrite = async (el: Element, attr: string) => {
    const v = el.getAttribute(attr);
    if (v && isLocal(v)) el.setAttribute(attr, await fileUrl(resolveRelative(dir, v)).catch(() => v));
  };
  await Promise.all([
    ...[...doc.querySelectorAll("img[src], source[src], video[src], audio[src]")].map((el) => rewrite(el, "src")),
    ...[...doc.querySelectorAll('link[rel~="stylesheet"][href]')].map((el) => rewrite(el, "href")),
  ]);
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'none'",
    "img-src data: blob: asset: http://asset.localhost",
    "media-src data: blob: asset: http://asset.localhost",
    "style-src 'unsafe-inline' asset: http://asset.localhost",
    "font-src data:",
    scripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
  ].join("; ");
  doc.head.prepend(csp);
  return "<!doctype html>\n" + doc.documentElement.outerHTML;
}

export function HtmlViewer({ buffer }: { buffer: Buffer }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [scripts, setScripts] = useState(scriptsAllowed.has(buffer.path));
  // Each built document gets a fresh iframe: swapping srcdoc on a live sandboxed frame can leave it blank.
  const [doc, setDoc] = useState<{ html: string; seq: number } | null>(null);

  useEffect(() => {
    if (mode !== "preview") return;
    let live = true;
    void sandboxedDoc(buffer.path, buffer.content ?? "", scripts).then(
      (html) => live && setDoc((prev) => ({ html, seq: (prev?.seq ?? 0) + 1 })),
    );
    return () => {
      live = false;
    };
  }, [buffer.path, buffer.content, scripts, mode]);

  const toggleScripts = () => {
    const next = !scripts;
    if (next) scriptsAllowed.add(buffer.path);
    else scriptsAllowed.delete(buffer.path);
    setScripts(next);
  };

  return (
    <div className="viewer">
      <Toolbar>
        <Segmented<"preview" | "source"> value={mode} onChange={setMode} options={[{ value: "preview", label: "Preview" }, { value: "source", label: "Source" }]} />
        <span className="spacer" />
        {mode === "preview" && (
          <button className={scripts ? "warn-toggle on" : "warn-toggle"} onClick={toggleScripts} title="Scripts never get network access either way">
            {scripts ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
            {scripts ? "Scripts allowed for this page" : "Scripts blocked"}
          </button>
        )}
      </Toolbar>
      {mode === "source" ? (
        <CodeEditor buffer={buffer} wrap />
      ) : (
        doc !== null && (
          <iframe
            key={doc.seq}
            className="html-frame"
            title={buffer.path}
            sandbox={scripts ? "allow-scripts" : ""}
            srcDoc={doc.html}
          />
        )
      )}
    </div>
  );
}
