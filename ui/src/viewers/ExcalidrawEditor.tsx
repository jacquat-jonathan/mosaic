import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useWorkspace, type Buffer } from "../state/workspace";
import { CodeEditor } from "./CodeEditor";
import { Segmented, Toolbar } from "./Toolbar";

// Fonts are served from the app bundle (see vite.config.ts), never from Excalidraw's CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

const ExcalidrawCanvas = lazy(() => import("./ExcalidrawCanvas"));

export const EMPTY_DRAWING = JSON.stringify(
  { type: "excalidraw", version: 2, source: "mosaic", elements: [], appState: { gridSize: null, viewBackgroundColor: "#ffffff" }, files: {} },
  null,
  2,
);

export function ExcalidrawEditor({ buffer }: { buffer: Buffer }) {
  const [mode, setMode] = useState<"draw" | "source">("draw");
  const parsed = useMemo(() => {
    try {
      const text = buffer.content?.trim() ? buffer.content : EMPTY_DRAWING;
      const data = JSON.parse(text);
      if (!Array.isArray(data.elements)) throw new Error("missing elements array");
      return { data, error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
    // Only external reloads re-seed the drawing; our own edits live in Excalidraw's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer.version, buffer.path]);
  const lastWritten = useRef(buffer.content);
  const showSource = mode === "source" || !parsed.data;

  return (
    <div className="viewer">
      <Toolbar>
        <Segmented<"draw" | "source"> value={showSource ? "source" : "draw"} onChange={setMode} options={[{ value: "draw", label: "Drawing" }, { value: "source", label: "Source" }]} />
        {parsed.error && <span className="toolbar-error">Can't open this drawing: {parsed.error}. The file is left untouched.</span>}
      </Toolbar>
      {showSource ? (
        <CodeEditor buffer={buffer} />
      ) : (
        <Suspense fallback={<div className="empty"><p>Loading drawing tools…</p></div>}>
          <ExcalidrawCanvas
            key={buffer.version}
            initial={parsed.data}
            onSave={(json) => {
              if (json === lastWritten.current) return;
              lastWritten.current = json;
              useWorkspace.getState().edit(buffer.path, json);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
