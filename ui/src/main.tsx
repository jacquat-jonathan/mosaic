import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// A file dropped from Finder where nothing handles it would make the webview navigate to it.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.types.includes("Files")) e.preventDefault();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only handle for driving the mock backend from browser automation.
if (import.meta.env.DEV) {
  void Promise.all([import("./ipc/api"), import("./ipc/mock"), import("./state/workspace"), import("./state/vault")]).then(
    ([apiMod, mock, ws, vault]) => {
      if (apiMod.inTauri) return;
      Object.assign(window, {
        __mosaic: {
          mockInvoke: mock.mockInvoke,
          useWorkspace: ws.useWorkspace,
          useVault: vault.useVault,
          /** Plays an agent changing bookmarks through the CLI/MCP. */
          async agentBookmarks(paths: string[]) {
            await mock.mockInvoke("set_bookmarks", { paths });
            window.dispatchEvent(new Event("mock-settings-changed"));
          },
          external(paths: string[]) {
            window.dispatchEvent(new CustomEvent("mock-vault-changed", { detail: { paths, root_missing: false } }));
          },
        },
      });
    },
  );
}
