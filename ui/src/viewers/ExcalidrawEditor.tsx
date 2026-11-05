import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace, type Buffer } from "../state/workspace";
import { CodeEditor } from "./CodeEditor";
import { DocumentToolbar } from "./Toolbar";
import { Notice, SegmentedControl } from "../design-system/components";
import { DesignSystemScope } from "../views/DesignSystemScope";

// Fonts are served from the app bundle (see vite.config.ts), never from Excalidraw's CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

const ExcalidrawCanvas = lazy(() => import("./ExcalidrawCanvas"));

export const EMPTY_DRAWING = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "mosaic",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  },
  null,
  2,
);

export function ExcalidrawEditor({ buffer }: { buffer: Buffer }) {
  const [mode, setMode] = useState<"draw" | "source">("draw");
  // biome-ignore lint/correctness/useExhaustiveDependencies: external reloads and view changes re-seed the drawing; canvas edits live in Excalidraw's state
  const parsed = useMemo(() => {
    try {
      const text = buffer.content?.trim() ? buffer.content : EMPTY_DRAWING;
      const data = JSON.parse(text);
      if (!Array.isArray(data.elements)) throw new Error("missing elements array");
      return { data, error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, [buffer.version, buffer.path, mode]);
  useEffect(() => {
    if (parsed.error && mode === "draw") setMode("source");
  }, [parsed.error, mode]);
  const lastWritten = useRef(buffer.content);
  const showSource = mode === "source" || !parsed.data;

  return (
    <div className="viewer">
      <DocumentToolbar label="Drawing controls">
        <SegmentedControl<"draw" | "source">
          label="Drawing view"
          value={showSource ? "source" : "draw"}
          onChange={setMode}
          options={[
            { value: "draw", label: "Drawing" },
            { value: "source", label: "Source" },
          ]}
        />
        {parsed.error && (
          <Notice tone="error">Can't open this drawing: {parsed.error}. The file is left untouched.</Notice>
        )}
      </DocumentToolbar>
      {showSource ? (
        <CodeEditor buffer={buffer} />
      ) : (
        <Suspense
          fallback={
            <DesignSystemScope>
              <Notice>Loading drawing tools…</Notice>
            </DesignSystemScope>
          }
        >
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
