import { useEffect, useRef, useState } from "react";
import type { Buffer } from "../state/workspace";
import { useDark } from "../theme";
import { CodeEditor } from "./CodeEditor";
import { Notice, SegmentedControl } from "../design-system/components";
import { DocumentToolbar } from "./Toolbar";
import { errorMessage } from "../ipc/types";

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
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const dark = useDark();

  useEffect(() => {
    if (mode !== "view" || !host.current) return;
    let live = true;
    setRendering(true);
    const t = setTimeout(() => {
      render(buffer.content ?? "", host.current!).then(
        () => {
          if (live) {
            setError(null);
            setRendering(false);
          }
        },
        (e) => {
          if (live) {
            setError(errorMessage(e));
            setRendering(false);
          }
        },
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `dark`: charts and graphs bake the theme into their SVG, so they redraw when it changes.
  }, [buffer.content, mode, render, dark]);

  const options = [
    { value: "view" as const, label },
    { value: "source" as const, label: "Source" },
  ];
  return (
    <div className="viewer">
      <DocumentToolbar label={`${label} controls`}>
        <SegmentedControl<"view" | "source">
          label={`${label} view`}
          value={mode}
          onChange={setMode}
          options={options}
        />
        {rendering && mode === "view" && <Notice>Rendering {label.toLowerCase()}…</Notice>}
        {error && mode === "view" && <Notice tone="error">{error}</Notice>}
      </DocumentToolbar>
      {mode === "source" ? (
        <CodeEditor buffer={buffer} />
      ) : (
        <div
          className="rendered-scroll"
          aria-busy={rendering || undefined}
          role="region"
          aria-label={`${label} preview`}
          tabIndex={0}
        >
          <div ref={host} className={error ? "rendered-host stale" : "rendered-host"} />
        </div>
      )}
    </div>
  );
}
