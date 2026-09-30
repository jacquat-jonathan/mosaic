import { useEffect, useState } from "react";
import { FilePlus, FolderPlus, FolderOpen } from "lucide-react";
import { api, pickFolder } from "./ipc/api";
import { useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";
import { FileTree } from "./views/FileTree";
import { Workspace } from "./views/Workspace";
import { ConfirmDialog, ContextMenu, ErrorToast } from "./views/Overlays";
import { newNote } from "./actions";
import { useShortcuts } from "./shortcuts";

export function App() {
  const vault = useVault((s) => s.vault);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    (async () => {
      const current = await api.currentVault();
      const last = current?.root ?? (await api.lastVault());
      if (last) await useVault.getState().openVault(last);
      setBooting(false);
    })();
  }, []);

  useShortcuts();

  if (booting) return <div className="app-loading" data-tauri-drag-region />;
  return (
    <>
      {vault ? <Main /> : <Welcome />}
      <ContextMenu />
      <ConfirmDialog />
      <ErrorToast />
    </>
  );
}

async function chooseVault() {
  const path = await pickFolder();
  if (!path) return;
  useWorkspace.setState({ panes: [{ id: "pane-0", tabs: [], active: null }], focused: "pane-0", buffers: {} });
  await useVault.getState().openVault(path);
}

function Welcome() {
  return (
    <main className="welcome" data-tauri-drag-region>
      <img src="/icon.png" alt="" width={96} height={96} />
      <h1>Mosaic</h1>
      <p>Open a folder to use it as your vault. Existing Obsidian vaults work as they are.</p>
      <button className="primary" onClick={() => void chooseVault()}>
        <FolderOpen size={16} /> Open folder…
      </button>
    </main>
  );
}

function Main() {
  const vault = useVault((s) => s.vault)!;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-head" data-tauri-drag-region>
          <button className="vault-name" title={vault.root} onClick={() => void chooseVault()}>
            {vault.name}
          </button>
          <div className="sidebar-actions">
            <button aria-label="New note" title="New note (⌘N)" onClick={() => void newNote("")}>
              <FilePlus size={16} />
            </button>
            <button aria-label="New folder" title="New folder" onClick={() => void useVault.getState().newFolder("")}>
              <FolderPlus size={16} />
            </button>
          </div>
        </div>
        <FileTree />
      </aside>
      <main className="main">
        <Workspace />
      </main>
    </div>
  );
}
