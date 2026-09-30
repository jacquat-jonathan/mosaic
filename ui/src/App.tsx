import { useEffect, useState } from "react";
import { FilePlus, FolderPlus, FolderOpen, Files, Search, Hash, PanelRight } from "lucide-react";
import { api, onIndexProgress, pickFolder } from "./ipc/api";
import { useVault } from "./state/vault";
import { FileTree } from "./views/FileTree";
import { Workspace } from "./views/Workspace";
import { ConfirmDialog, ContextMenu, ErrorToast } from "./views/Overlays";
import { newNote } from "./actions";
import { useShortcuts } from "./shortcuts";
import { useUi, type SidebarTab } from "./state/ui";
import { SearchPanel } from "./views/SearchPanel";
import { TagsPanel } from "./views/TagsPanel";
import { RightPanel } from "./views/RightPanel";
import { QuickSwitcher } from "./views/QuickSwitcher";
import { startVaultSync } from "./sync";

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

  useEffect(() => {
    let off: (() => void) | undefined;
    void onIndexProgress((p) => {
      useVault.setState({ indexing: p.finished ? null : { done: p.done, total: p.total } });
      if (p.finished) void useVault.getState().refresh();
    }).then((u) => (off = u));
    let offSync: (() => void) | undefined;
    void startVaultSync().then((u) => (offSync = u));
    return () => {
      off?.();
      offSync?.();
    };
  }, []);

  if (booting) return <div className="app-loading" data-tauri-drag-region />;
  return (
    <>
      {vault ? <Main /> : <Welcome />}
      <ContextMenu />
      <ConfirmDialog />
      <QuickSwitcher />
      <ErrorToast />
    </>
  );
}

async function chooseVault() {
  const path = await pickFolder();
  if (!path) return;
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

const TABS: { id: SidebarTab; label: string; icon: typeof Files }[] = [
  { id: "files", label: "Files", icon: Files },
  { id: "search", label: "Search (⇧⌘F)", icon: Search },
  { id: "tags", label: "Tags", icon: Hash },
];

function Main() {
  const vault = useVault((s) => s.vault)!;
  const tab = useUi((s) => s.sidebarTab);
  const right = useUi((s) => s.rightPanel);
  const indexing = useVault((s) => s.indexing);
  const offline = useVault((s) => s.offline);
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
        <div className="sidebar-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              title={t.label}
              className={tab === t.id ? "active" : ""}
              onClick={() => (t.id === "search" ? useUi.getState().showSearch() : useUi.getState().setSidebarTab(t.id))}
            >
              <t.icon size={15} />
            </button>
          ))}
          <span className="spacer" />
          <button title="Toggle backlinks panel (⌥⌘B)" className={right ? "active" : ""} onClick={() => useUi.getState().toggleRightPanel()}>
            <PanelRight size={15} />
          </button>
        </div>
        {tab === "files" && <FileTree />}
        {tab === "search" && <SearchPanel />}
        {tab === "tags" && <TagsPanel />}
        {indexing && (
          <div className="status">
            Indexing {indexing.done.toLocaleString()} / {indexing.total.toLocaleString()}
          </div>
        )}
      </aside>
      <main className="main">
        {offline && (
          <div className="notice warn" role="alert">
            <span>The vault folder is unavailable (disk ejected or folder moved). Unsaved changes are kept in memory.</span>
            <button onClick={() => void useVault.getState().openVault(vault.root)}>Retry</button>
          </div>
        )}
        <Workspace />
      </main>
      {right && <RightPanel />}
    </div>
  );
}
