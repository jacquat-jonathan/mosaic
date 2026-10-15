import { useEffect, useState } from "react";
import { Minus, Plus, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import type { Buffer } from "../state/workspace";
import { api, fileUrl, htmlPreviewDocumentUrl } from "../ipc/api";
import { parentOf } from "../state/vault";
import { CodeEditor } from "./CodeEditor";
import { Segmented, Toolbar } from "./Toolbar";

/** Pages opted in to scripts this session (never persisted: it's an explicit, per-file choice). */
const scriptsAllowed = new Set<string>();
export const HTML_ZOOM_MIN = 0.5;
export const HTML_ZOOM_MAX = 2;
export const HTML_ZOOM_STEP = 0.1;

export function clampHtmlZoom(value: number): number {
  return Math.round(Math.min(HTML_ZOOM_MAX, Math.max(HTML_ZOOM_MIN, value)) * 10) / 10;
}

export const isLocalHtmlResource = (url: string) => !!url && !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(url);

export function resolveHtmlResource(dir: string, rel: string): string {
  const parts = dir.split("/").filter(Boolean);
  for (const seg of decodeURI(rel.split(/[?#]/)[0]).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** The preview may read only vault assets. Network schemes stay absent from every directive. */
export function htmlPreviewCsp(scripts: boolean): string {
  const local = "asset: http://asset.localhost";
  return [
    "default-src 'none'",
    `img-src data: blob: ${local}`,
    `media-src data: blob: ${local}`,
    `style-src 'unsafe-inline' ${local}`,
    `font-src data: ${local}`,
    `connect-src data: ${local}`,
    scripts ? `script-src data: ${local}` : "script-src 'none'",
  ].join("; ");
}

const scriptType = (el: Element) =>
  !el.getAttribute("type") || /^(?:module|text|application)\/(?:java|ecma)script$/i.test(el.getAttribute("type")!);
const dataMime = (path: string) =>
  path.toLowerCase().endsWith(".json")
    ? "application/json"
    : path.toLowerCase().endsWith(".css")
      ? "text/css"
      : "text/plain";

/** Literal relative fetches are embedded so they also work in WebKit's opaque sandbox origin.
 * Dynamic and external URLs are left alone (and external ones remain blocked by CSP). */
export async function embedLocalFetches(
  source: string,
  dir: string,
  load: (path: string) => Promise<string | null>,
): Promise<string> {
  const pattern = /\bfetch\s*\(\s*(["'])([^"']+)\1/g;
  const matches = [...source.matchAll(pattern)].filter((match) => isLocalHtmlResource(match[2]));
  const replacements = await Promise.all(
    matches.map(async (match) => {
      const path = resolveHtmlResource(dir, match[2]);
      const content = await load(path).catch(() => null);
      const encoded = content === null ? null : encodeURIComponent(content).replace(/'/g, "%27");
      return encoded === null
        ? null
        : {
            from: match.index! + match[0].indexOf(match[2]),
            to: match.index! + match[0].indexOf(match[2]) + match[2].length,
            value: `data:${dataMime(path)};charset=utf-8,${encoded}`,
          };
    }),
  );
  let out = source;
  for (const replacement of replacements
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => b.from - a.from)) {
    out = out.slice(0, replacement.from) + replacement.value + out.slice(replacement.to);
  }
  return out;
}

/**
 * Builds the sandboxed document. Its base URL makes linked CSS/scripts and relative fetches (for
 * example JSON data) resolve beside the HTML file; CSP still blocks every network scheme.
 */
async function sandboxedDoc(path: string, html: string, scripts: boolean): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const dir = parentOf(path);
  const rewrite = async (el: Element, attr: string) => {
    const v = el.getAttribute(attr);
    if (v && isLocalHtmlResource(v)) el.setAttribute(attr, await fileUrl(resolveHtmlResource(dir, v)).catch(() => v));
  };
  await Promise.all([
    ...[...doc.querySelectorAll("img[src], source[src], video[src], audio[src]")].map((el) => rewrite(el, "src")),
    ...[...doc.querySelectorAll('link[rel~="stylesheet"][href]')].map((el) => rewrite(el, "href")),
    ...[...doc.querySelectorAll("script[src]")].map((el) => rewrite(el, "src")),
    ...[...doc.querySelectorAll("script:not([src])")].filter(scriptType).map(async (el) => {
      const source = await embedLocalFetches(
        el.textContent ?? "",
        dir,
        async (resource) => (await api.read(resource)).content,
      );
      el.textContent = "";
      el.setAttribute("src", `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
    }),
  ]);
  const base = doc.createElement("base");
  base.href = await fileUrl(path);
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = htmlPreviewCsp(scripts);
  doc.head.prepend(base);
  doc.head.prepend(csp);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

export function HtmlViewer({ buffer }: { buffer: Buffer }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [scripts, setScripts] = useState(scriptsAllowed.has(buffer.path));
  const [zoom, setZoom] = useState(1);
  // Each built document gets a fresh iframe: swapping srcdoc on a live sandboxed frame can leave it blank.
  const [doc, setDoc] = useState<{ url: string; seq: number } | null>(null);

  useEffect(() => {
    if (mode !== "preview") return;
    let live = true;
    void sandboxedDoc(buffer.path, buffer.content ?? "", scripts)
      .then(htmlPreviewDocumentUrl)
      .then((url) => {
        if (live) setDoc((prev) => ({ url, seq: (prev?.seq ?? 0) + 1 }));
      });
    return () => {
      live = false;
    };
  }, [buffer.path, buffer.content, scripts, mode]);

  useEffect(() => setZoom(1), [buffer.path]);

  const toggleScripts = () => {
    const next = !scripts;
    if (next) scriptsAllowed.add(buffer.path);
    else scriptsAllowed.delete(buffer.path);
    setScripts(next);
  };

  return (
    <div className="viewer">
      <Toolbar>
        <Segmented<"preview" | "source">
          value={mode}
          onChange={setMode}
          options={[
            { value: "preview", label: "Preview" },
            { value: "source", label: "Source" },
          ]}
        />
        <span className="spacer" />
        {mode === "preview" && (
          <>
            <div className="html-zoom" aria-label="HTML preview zoom">
              <button
                aria-label="Zoom out"
                title="Zoom out"
                disabled={zoom <= HTML_ZOOM_MIN}
                onClick={() => setZoom((value) => clampHtmlZoom(value - HTML_ZOOM_STEP))}
              >
                <Minus size={14} />
              </button>
              <button aria-label="Reset zoom" title="Reset zoom" onClick={() => setZoom(1)}>
                <RotateCcw size={13} />
                <span>{Math.round(zoom * 100)}%</span>
              </button>
              <button
                aria-label="Zoom in"
                title="Zoom in"
                disabled={zoom >= HTML_ZOOM_MAX}
                onClick={() => setZoom((value) => clampHtmlZoom(value + HTML_ZOOM_STEP))}
              >
                <Plus size={14} />
              </button>
            </div>
            <button
              className={scripts ? "warn-toggle on" : "warn-toggle"}
              onClick={toggleScripts}
              title="Scripts never get network access either way"
            >
              {scripts ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
              {scripts ? "Scripts allowed for this page" : "Scripts blocked"}
            </button>
          </>
        )}
      </Toolbar>
      {mode === "source" ? (
        <CodeEditor buffer={buffer} wrap />
      ) : (
        doc !== null && (
          <div className="html-frame-scroll">
            <div
              className="html-frame-zoom"
              style={{ width: `${Math.max(100, zoom * 100)}%`, height: `${Math.max(100, zoom * 100)}%` }}
            >
              <iframe
                key={doc.seq}
                className="html-frame"
                style={{ width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})` }}
                title={buffer.path}
                sandbox={scripts ? "allow-scripts allow-same-origin" : "allow-same-origin"}
                src={doc.url}
              />
            </div>
          </div>
        )
      )}
    </div>
  );
}
