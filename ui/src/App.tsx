import { useEffect, useState } from "react";
import { FilePlus, FolderPlus, FolderOpen, Files, Search, Hash, Shapes, Bot, Bookmark, ChevronDown, ChevronsDownUp, PanelLeftClose } from "lucide-react";
import { api, onIndexProgress, pickFolder, revealInFinder } from "./ipc/api";
import { useVault } from "./state/vault";
import { FileTree } from "./views/FileTree";
import { Workspace } from "./views/Workspace";
import { ConfirmDialog, ContextMenu, ErrorToast, PromptDialog } from "./views/Overlays";
import { createVault, newNote, NEW_KINDS, newOfKind, openVaultFolder } from "./actions";
import { useShortcuts } from "./shortcuts";
import { RIGHT_DEFAULT, SIDEBAR_DEFAULT, useUi, type MenuItem, type SidebarTab } from "./state/ui";
import { SearchPanel } from "./views/SearchPanel";
import { TagsPanel } from "./views/TagsPanel";
import { RightPanel } from "./views/RightPanel";
import { QuickSwitcher } from "./views/QuickSwitcher";
import { startVaultSync } from "./sync";
import { ConnectAi } from "./views/ConnectAi";
import { Picker } from "./views/Picker";
import { BookmarksPanel } from "./views/BookmarksPanel";
import { Resizer } from "./views/Resizer";
import { shortcutOf } from "./commands";

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
      <PromptDialog />
      <QuickSwitcher />
      <Picker />
      <ConnectAi />
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
      <div className="welcome-actions">
        <button className="primary" onClick={() => void chooseVault()}>
          <FolderOpen size={16} /> Open folder…
        </button>
        <button className="secondary" onClick={() => void createVault()}>
          <FolderPlus size={16} /> Create new vault…
        </button>
      </div>
    </main>
  );
}

const TABS: { id: SidebarTab; label: string; icon: typeof Files }[] = [
  { id: "files", label: "Files", icon: Files },
  { id: "search", label: "Search (⇧⌘F)", icon: Search },
  { id: "bookmarks", label: "Bookmarks", icon: Bookmark },
  { id: "tags", label: "Tags", icon: Hash },
];

/** Dropdown under the vault name: recent vaults, open or create another, reveal in Finder. */
async function showVaultMenu(anchor: DOMRect) {
  const current = useVault.getState().vault;
  const recent = await api.recentVaults().catch(() => []);
  const others = recent.filter((v) => v.root !== current?.root);
  const items: MenuItem[] = [
    ...recent.map<MenuItem>((v) => ({
      label: v.name,
      detail: v.exists ? v.root.replace(/^\/Users\/[^/]+/, "~") : "Folder not found",
      checked: v.root === current?.root,
      disabled: !v.exists,
      action: () => v.root !== current?.root && void useVault.getState().openVault(v.root),
    })),
    { label: "", separator: true },
    { label: "Open folder as vault…", action: () => void openVaultFolder() },
    { label: "Create new vault…", action: () => void createVault() },
    { label: "", separator: true },
    { label: "Reveal vault in Finder", action: () => void revealInFinder("") },
    ...(others.length
      ? [
          {
            label: "Remove from list",
            children: others.map<MenuItem>((v) => ({ label: v.name, detail: v.exists ? undefined : "Folder not found", action: () => void api.forgetVault(v.root) })),
          },
        ]
      : []),
  ];
  useUi.getState().showMenu(anchor.left, anchor.bottom + 4, items);
}

function Main() {
  const vault = useVault((s) => s.vault)!;
  const tab = useUi((s) => s.sidebarTab);
  const right = useUi((s) => s.rightPanel);
  const left = useUi((s) => s.leftSidebar);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const rightWidth = useUi((s) => s.rightWidth);
  const indexing = useVault((s) => s.indexing);
  const offline = useVault((s) => s.offline);
  const ui = useUi.getState;
  return (
    <div className={`shell ${left ? "" : "no-left"}`}>
      {left && (
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <div className="sidebar-head" data-tauri-drag-region>
            <button
              className="vault-name"
              title={`${vault.root}\nSwitch, open or create a vault`}
              aria-haspopup="menu"
              onClick={(e) => void showVaultMenu(e.currentTarget.getBoundingClientRect())}
            >
              <span>{vault.name}</span>
              <ChevronDown size={13} />
            </button>
            <button className="head-button" aria-label="Hide sidebar" title={`Hide sidebar (${shortcutOf("toggle-left")})`} onClick={() => ui().toggleLeftSidebar()}>
              <PanelLeftClose size={16} />
            </button>
          </div>
          <div className="sidebar-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                title={t.label}
                className={tab === t.id ? "active" : ""}
                onClick={() => (t.id === "search" ? ui().showSearch() : ui().setSidebarTab(t.id))}
              >
                <t.icon size={15} />
              </button>
            ))}
            <span className="spacer" />
            <button title="Connect AI (MCP / CLI)" onClick={() => ui().setConnectAi(true)}>
              <Bot size={15} />
            </button>
          </div>
          {tab === "files" && (
            <>
              <div className="tree-toolbar">
                <button aria-label="New note" title={`New note (${shortcutOf("new-note")})`} onClick={() => void newNote("")}>
                  <FilePlus size={15} />
                </button>
                <button
                  aria-label="New…"
                  title="New canvas, drawing, chart or graph"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    ui().showMenu(r.left, r.bottom + 4, NEW_KINDS.map((k) => ({ label: k.label, action: () => void newOfKind("", k) })));
                  }}
                >
                  <Shapes size={15} />
                </button>
                <button aria-label="New folder" title={`New folder (${shortcutOf("new-folder")})`} onClick={() => void useVault.getState().newFolder("")}>
                  <FolderPlus size={15} />
                </button>
                <span className="spacer" />
                <button aria-label="Collapse all folders" title="Collapse all folders" onClick={() => useVault.setState({ expanded: new Set() })}>
                  <ChevronsDownUp size={15} />
                </button>
              </div>
              <FileTree />
            </>
          )}
          {tab === "search" && <SearchPanel />}
          {tab === "bookmarks" && <BookmarksPanel />}
          {tab === "tags" && <TagsPanel />}
          {indexing && (
            <div className="status">
              Indexing {indexing.done.toLocaleString()} / {indexing.total.toLocaleString()}
            </div>
          )}
          <Resizer
            side="right"
            label="Resize sidebar"
            width={sidebarWidth}
            onResize={(w) => ui().setSidebarWidth(w)}
            onReset={() => ui().setSidebarWidth(SIDEBAR_DEFAULT)}
          />
        </aside>
      )}
      <main className="main">
        {offline && (
          <div className="notice warn" role="alert">
            <span>The vault folder is unavailable (disk ejected or folder moved). Unsaved changes are kept in memory.</span>
            <button onClick={() => void useVault.getState().openVault(vault.root)}>Retry</button>
          </div>
        )}
        <Workspace />
      </main>
      {right && (
        <div className="right-wrap" style={{ width: rightWidth }}>
          <Resizer
            side="left"
            label="Resize right panel"
            width={rightWidth}
            onResize={(w) => ui().setRightWidth(w)}
            onReset={() => ui().setRightWidth(RIGHT_DEFAULT)}
          />
          <RightPanel />
        </div>
      )}
    </div>
  );
}
