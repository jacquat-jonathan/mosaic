import { DesignSystemScope } from "./DesignSystemScope";
import "./windowChrome.css";

export function WindowChrome({ vaultName, version }: { vaultName: string; version: string }) {
  return (
    <DesignSystemScope as="header" className="window-chrome" aria-label="Window title" data-tauri-drag-region>
      <span className="window-title" data-tauri-drag-region>
        Mosaic — {vaultName}
      </span>
      <span className="window-version" data-tauri-drag-region>
        v{version || "—"}
      </span>
    </DesignSystemScope>
  );
}
