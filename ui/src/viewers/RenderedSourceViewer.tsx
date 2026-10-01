import { useEffect, useRef, useState } from "react";
import type { Buffer } from "../state/workspace";
import { useDark } from "../theme";
import { CodeEditor } from "./CodeEditor";
import { Segmented, Toolbar } from "./Toolbar";

/** A text file shown rendered (chart, graph…) with a Source tab; render errors appear inline. */
export function RenderedSourceViewer({
  buffer,
  render,
  label,
}: {
  buffer: Buffer;
  render(source: string, el: HTMLElement): Promise<void>;
  label: string;
}) {
  const [mode, setMode] = useState<"view" | "source">("view");
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const dark = useDark();

  useEffect(() => {
    if (mode !== "view" || !host.current) return;
    let live = true;
    const t = setTimeout(() => {
      render(buffer.content ?? "", host.current!).then(
        () => live && setError(null),
        (e) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `dark`: charts and graphs bake the theme into their SVG, so they redraw when it changes.
  }, [buffer.content, mode, render, dark]);

  return (
    <div className="viewer">
      <Toolbar>
        <Segmented<"view" | "source"> value={mode} onChange={setMode} options={[{ value: "view", label }, { value: "source", label: "Source" }]} />
        {error && mode === "view" && <span className="toolbar-error">{error}</span>}
      </Toolbar>
      {mode === "source" ? (
        <CodeEditor buffer={buffer} />
      ) : (
        <div className="rendered-scroll">
          <div ref={host} className={error ? "rendered-host stale" : "rendered-host"} />
        </div>
      )}
    </div>
  );
}
