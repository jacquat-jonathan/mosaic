import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

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
          external(paths: string[]) {
            window.dispatchEvent(new CustomEvent("mock-vault-changed", { detail: { paths, root_missing: false } }));
          },
        },
      });
    },
  );
}
