import { useRef } from "react";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

type Scene = { elements: readonly { version: number }[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };

/** Loaded lazily: Excalidraw is large. Saves only when the drawing itself changes, not on selection/scroll. */
export default function ExcalidrawCanvas({ initial, onSave }: { initial: Scene; onSave(json: string): void }) {
  const lastVersion = useRef<number | null>(null);
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return (
    <div className="excalidraw-host">
      <Excalidraw
        initialData={{ elements: initial.elements as never, appState: { ...(initial.appState ?? {}), collaborators: new Map() } as never, files: (initial.files ?? {}) as never, scrollToContent: true }}
        theme={dark ? "dark" : "light"}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true } }}
        onChange={(elements, appState, files) => {
          const version = elements.reduce((n, e) => n + e.version, 0) + Object.keys(files).length;
          if (lastVersion.current === null) {
            lastVersion.current = version;
            return;
          }
          if (version === lastVersion.current) return;
          lastVersion.current = version;
          onSave(serializeAsJSON(elements, appState, files, "local"));
        }}
      />
    </div>
  );
}
