import { useEffect, useMemo, useState } from "react";
import { Globe2, Minus, Plus, RotateCcw, ShieldAlert, ShieldCheck, WifiOff } from "lucide-react";
import type { Buffer } from "../state/workspace";
import { api, fileUrl, htmlPreviewDocumentUrl } from "../ipc/api";
import { parentOf } from "../state/vault";
import { CodeEditor } from "./CodeEditor";
import { Segmented, Toolbar } from "./Toolbar";
import { useVaultPreferences } from "../state/vaultPreferences";
import { renderMermaid } from "../editor/render";
import { sanitizeMermaidSvg } from "../sanitizeSvg";

/** Per-page overrides for this session. Vault preferences provide the default and stay persistent. */
const scriptOverrides = new Map<string, boolean>();
/** Explicit internet decisions, keyed by vault, page and a hash of its exact current content. */
const networkPermissions = new Map<string, boolean>();
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

/** The preview may read vault assets plus only the external origins explicitly approved by the user. */
export function htmlPreviewCsp(scripts: boolean, externalOrigins: readonly string[] = []): string {
  const local = "asset: http://asset.localhost";
  const remote = externalOrigins.length ? ` ${externalOrigins.join(" ")}` : "";
  return [
    "default-src 'none'",
    `img-src data: blob: ${local}${remote}`,
    `media-src data: blob: ${local}${remote}`,
    `style-src 'unsafe-inline' ${local}${remote}`,
    `font-src data: ${local}${remote}`,
    `connect-src data: ${local}${remote}`,
    scripts ? `script-src data: ${local}${remote}` : "script-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join("; ");
}

const EXTERNAL_URL = /(?:https?:)?\/\/[^\s"'<>`()]+/gi;

function addExternalOrigins(value: string | null, origins: Set<string>) {
  if (!value) return;
  for (const match of value.matchAll(EXTERNAL_URL)) {
    try {
      const url = new URL(match[0].startsWith("//") ? `https:${match[0]}` : match[0]);
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
    } catch {
      // Malformed URLs do not get a network grant.
    }
  }
}

/** Finds origins that the initial document can request. Links and forms are excluded because they
 * need a user action; resource attributes, CSS and script URL literals are included. */
export function externalHtmlOrigins(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const origins = new Set<string>();
  const resources: [string, string][] = [
    ["script[src]", "src"],
    ["img[src], source[src], video[src], audio[src], track[src], input[src]", "src"],
    ["img[srcset], source[srcset]", "srcset"],
    ["video[poster]", "poster"],
    ["image[href], use[href]", "href"],
    ["image[xlink\\:href], use[xlink\\:href]", "xlink:href"],
    ["[background]", "background"],
  ];
  for (const [selector, attribute] of resources) {
    for (const element of doc.querySelectorAll(selector)) addExternalOrigins(element.getAttribute(attribute), origins);
  }
  const resourceLinks = new Set(["stylesheet", "icon", "preload", "modulepreload"]);
  for (const link of doc.querySelectorAll("link[href]")) {
    const rel = new Set((link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/));
    if ([...rel].some((value) => resourceLinks.has(value))) addExternalOrigins(link.getAttribute("href"), origins);
  }
  for (const element of doc.querySelectorAll("style, script:not([src])"))
    addExternalOrigins(element.textContent, origins);
  for (const element of doc.querySelectorAll("[style]")) addExternalOrigins(element.getAttribute("style"), origins);
  return [...origins].sort();
}

/** SHA-256 keeps a session grant attached to this exact page content. Any edit requires a new
 * decision. WebKit provides SubtleCrypto; the exact-content fallback is only for test/legacy hosts. */
export async function htmlContentHash(content: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `exact-${content}`;
}

export type HtmlScriptPermission = { allowed: boolean; source: "vault" | "page"; label: string };

/** Resolves a page's session override against the vault-wide default and supplies clear UI copy. */
export function htmlScriptPermission(vaultDefault: boolean, pageOverride?: boolean): HtmlScriptPermission {
  const allowed = pageOverride ?? vaultDefault;
  const source = pageOverride === undefined ? "vault" : "page";
  return {
    allowed,
    source,
    label:
      source === "page"
        ? `Scripts ${allowed ? "allowed" : "blocked"} for this page`
        : `Scripts ${allowed ? "allowed" : "blocked"} by vault setting`,
  };
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
 * Dynamic and external URLs are left alone; external ones require a separate internet grant. */
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

type MermaidRenderer = (source: string) => Promise<string>;

/** Replaces common static Mermaid containers with sanitized SVG from Mosaic's bundled renderer.
 * This happens before the document enters its iframe, so it works even when page scripts are off. */
export async function renderHtmlMermaid(doc: Document, renderer: MermaidRenderer = renderMermaid): Promise<void> {
  const found = [
    ...doc.querySelectorAll<HTMLElement>(".mermaid"),
    ...[...doc.querySelectorAll<HTMLElement>("pre > code.language-mermaid")].map((code) => code.parentElement!),
  ];
  const targets = [...new Set(found)].filter(
    (candidate) => !found.some((other) => other !== candidate && other.contains(candidate)),
  );
  await Promise.all(
    targets.map(async (target) => {
      const source = target.textContent ?? "";
      try {
        const rendered = doc.createElement("div");
        rendered.className = "mosaic-mermaid";
        rendered.innerHTML = sanitizeMermaidSvg(await renderer(source));
        target.replaceWith(rendered);
      } catch {
        // Leave invalid diagrams as source so the rest of the HTML preview still renders.
      }
    }),
  );
}

/**
 * Builds the sandboxed document. Its base URL makes linked CSS/scripts and relative fetches (for
 * example JSON data) resolve beside the HTML file; CSP allows only explicitly granted origins.
 */
async function sandboxedDoc(
  path: string,
  html: string,
  scripts: boolean,
  externalOrigins: readonly string[],
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Navigation is not a resource grant and would replace the protected preview with a remote page.
  for (const refresh of doc.querySelectorAll('meta[http-equiv="refresh" i]')) refresh.remove();
  // Speculative hints can disclose a hostname without loading a visible resource and are never needed
  // for a local preview. Remove them so the permission prompt always precedes network activity.
  for (const hint of doc.querySelectorAll(
    'link[rel~="dns-prefetch"], link[rel~="preconnect"], link[rel~="prefetch"], link[rel~="prerender"]',
  ))
    hint.remove();
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
  await renderHtmlMermaid(doc);
  const base = doc.createElement("base");
  base.href = await fileUrl(path);
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = htmlPreviewCsp(scripts, externalOrigins);
  doc.head.prepend(base);
  doc.head.prepend(csp);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

export function HtmlViewer({ buffer }: { buffer: Buffer }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [, setPermissionRevision] = useState(0);
  const [hashedContent, setHashedContent] = useState<{ content: string; hash: string } | null>(null);
  const vaultRoot = useVaultPreferences((state) => state.root);
  const vaultScripts = useVaultPreferences((state) => state.value.allow_html_scripts);
  const overrideKey = `${vaultRoot ?? ""}\0${buffer.path}`;
  const permission = htmlScriptPermission(vaultScripts, scriptOverrides.get(overrideKey));
  const scripts = permission.allowed;
  const content = buffer.content ?? "";
  const requestedOrigins = useMemo(() => externalHtmlOrigins(content), [content]);
  const contentHash = hashedContent?.content === content ? hashedContent.hash : null;
  const networkKey = contentHash === null ? null : `${overrideKey}\0${contentHash}`;
  const networkChoice = networkKey === null ? undefined : networkPermissions.get(networkKey);
  const internetAllowed = networkChoice === true;
  const [zoom, setZoom] = useState(1);
  // Each built document gets a fresh iframe: swapping srcdoc on a live sandboxed frame can leave it blank.
  const [doc, setDoc] = useState<{ url: string; seq: number } | null>(null);

  useEffect(() => {
    let live = true;
    void htmlContentHash(content).then((hash) => {
      if (live) setHashedContent({ content, hash });
    });
    return () => {
      live = false;
    };
  }, [content]);

  useEffect(() => {
    if (mode !== "preview") return;
    let live = true;
    void sandboxedDoc(buffer.path, content, scripts, internetAllowed ? requestedOrigins : [])
      .then(htmlPreviewDocumentUrl)
      .then((url) => {
        if (live) setDoc((prev) => ({ url, seq: (prev?.seq ?? 0) + 1 }));
      });
    return () => {
      live = false;
    };
  }, [buffer.path, content, scripts, internetAllowed, requestedOrigins, mode]);

  useEffect(() => setZoom(1), [buffer.path]);

  const toggleScripts = () => {
    const next = !scripts;
    if (next === vaultScripts) scriptOverrides.delete(overrideKey);
    else scriptOverrides.set(overrideKey, next);
    setPermissionRevision((revision) => revision + 1);
  };

  const chooseInternet = (allowed: boolean) => {
    if (networkKey === null) return;
    networkPermissions.set(networkKey, allowed);
    setPermissionRevision((revision) => revision + 1);
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
              title="Override the vault setting for this page until Mosaic quits. Internet access is controlled separately."
            >
              {scripts ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
              {permission.label}
            </button>
            {networkChoice !== undefined && (
              <button
                className={internetAllowed ? "warn-toggle on" : "warn-toggle"}
                onClick={() => chooseInternet(!internetAllowed)}
                title={`${internetAllowed ? "Block" : "Allow"} the listed internet origins for this page content until Mosaic quits: ${requestedOrigins.join(", ")}`}
              >
                {internetAllowed ? <Globe2 size={14} /> : <WifiOff size={14} />}
                {internetAllowed ? "Internet allowed for this page" : "Internet blocked for this page"}
              </button>
            )}
          </>
        )}
      </Toolbar>
      {mode === "preview" && contentHash !== null && requestedOrigins.length > 0 && networkChoice === undefined && (
        <div className="notice warn html-network-prompt" role="alert" aria-label="External resource permission">
          <Globe2 size={16} aria-hidden="true" />
          <span>
            <strong>Allow this page to access the internet?</strong> Requested origins:{" "}
            <code>{requestedOrigins.join(", ")}</code>. Only these origins are granted for this exact page content;
            scripts remain controlled separately.
          </span>
          <div className="button-row">
            <button onClick={() => chooseInternet(false)}>Keep blocked</button>
            <button onClick={() => chooseInternet(true)}>Allow for this session</button>
          </div>
        </div>
      )}
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
