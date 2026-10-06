import { useEffect, useState } from "react";
import { FilePlus, FolderPlus, FolderOpen, Files, Search, Shapes, Bot, ChevronDown, ChevronsDownUp, PanelLeftClose, Settings as Gear, CalendarDays } from "lucide-react";
import { api, onIndexProgress, pickFolder, revealInFinder } from "./ipc/api";
import { useVault } from "./state/vault";
import { FileTree } from "./views/FileTree";
import { Workspace } from "./views/Workspace";
import { ConfirmDialog, ContextMenu, ErrorToast, PromptDialog } from "./views/Overlays";
import { createVault, newNote, newNoteDir, NEW_KINDS, newOfKind, openDailyNote, openVaultFolder } from "./actions";
import { useShortcuts } from "./shortcuts";
import { RIGHT_DEFAULT, SIDEBAR_DEFAULT, useUi, type MenuItem, type Destination } from "./state/ui";
import { RightPanel } from "./views/RightPanel";
import { QuickSwitcher } from "./views/QuickSwitcher";
import { startBookmarkSync, startVaultSync } from "./sync";
import { startUpdateListeners } from "./views/Settings";
import "./state/settings";
import { Picker } from "./views/Picker";
import { Resizer } from "./views/Resizer";
import { HistoryModal } from "./views/HistoryModal";
import { AreaSidebar } from "./views/AreaSidebar";
import { useWorkspace } from "./state/workspace";
import { contextKind } from "./views/specialTabs";
import { useChat } from "./state/chat";
import { useAttention, startAttention } from "./state/attention";
import { useReview } from "./state/review";
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
    // Subscriptions resolve asynchronously; if the effect is cleaned up first (React runs effects twice in
    // development), unsubscribe as soon as they arrive instead of leaking a second listener.
    let cancelled = false;
    const offs: (() => void)[] = [];
    const keep = (p: Promise<() => void>) => void p.then((off) => (cancelled ? off() : offs.push(off)));
    keep(
      onIndexProgress((p) => {
        useVault.setState({ indexing: p.finished ? null : { done: p.done, total: p.total } });
        if (p.finished) void useVault.getState().refresh();
      }),
    );
    keep(startVaultSync());
    keep(startBookmarkSync());
    keep(startUpdateListeners());
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
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
      <HistoryModal />
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

const TABS: { id: Destination; label: string; icon: typeof Files }[] = [
  { id: "notes", label: "Notes", icon: Files },
  { id: "find", label: "Find", icon: Search },
  { id: "plan", label: "Plan", icon: CalendarDays },
  { id: "ai", label: "AI", icon: Bot },
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
  const tab = useUi((s) => s.destination);
  const right = useUi((s) => s.rightPanel);
  const left = useUi((s) => s.leftSidebar);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const rightWidth = useUi((s) => s.rightWidth);
  const indexing = useVault((s) => s.indexing);
  const offline = useVault((s) => s.offline);
  const pendingReviews = useReview((s) => s.pending.length);
  const chatAttention = useChat(s => Object.values(s.chats).filter(c => c.run === null && (c.items.at(-1)?.kind === "error" || c.noMosaic)).length);
  const attention = useAttention((s) => s.count);
  const active = useWorkspace((s) => s.panes.find(p => p.id === s.focused)?.active ?? null);
  useEffect(() => startAttention(), [vault.root]);
  const ui = useUi.getState;
  useEffect(() => {
    const context = window.matchMedia("(max-width: 1100px)");
    const area = window.matchMedia("(max-width: 800px)");
    const collapseContext = () => { if (context.matches) useUi.setState({ rightPanel: false }); };
    const collapseArea = () => { if (area.matches) useUi.setState({ leftSidebar: false }); };
    collapseContext(); collapseArea();
    context.addEventListener("change", collapseContext); area.addEventListener("change", collapseArea);
    return () => { context.removeEventListener("change", collapseContext); area.removeEventListener("change", collapseArea); };
  }, []);
  useEffect(() => {
    if (window.matchMedia("(max-width: 800px)").matches) useUi.setState({ leftSidebar: false });
  }, [active]);
  // Agents' proposals arrive from another process: check for them while this vault is open.
  useEffect(() => useReview.getState().watch(), [vault.root]);
  return (
    <div className={`shell ${left ? "" : "no-left"}`}>
      <header className="window-chrome" data-tauri-drag-region><span data-tauri-drag-region>Mosaic — {vault.name}</span></header>
      <div className="shell-body">
      <nav className="icon-bar" aria-label="Destinations" data-focus-region tabIndex={-1}>
        <div role="tablist" aria-orientation="vertical" className="icon-bar-group">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              onKeyDown={e => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
                e.preventDefault(); const i = TABS.indexOf(t); const at = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + TABS.length) % TABS.length;
                useUi.setState({ destination: TABS[at].id, leftSidebar: true }); (e.currentTarget.parentElement?.children[at] as HTMLElement)?.focus();
              }}
              aria-label={t.label}
              title={left && tab === t.id ? `${t.label} — click to hide the sidebar` : t.label}
              className={tab === t.id ? "active" : ""}
              onClick={() => ui().selectDestination(t.id)}
            >
              <t.icon size={18} />
              {t.id === "ai" && pendingReviews + attention + chatAttention > 0 && <span className="tab-badge" aria-label={`${pendingReviews + attention + chatAttention} need attention`}>{pendingReviews + attention + chatAttention}</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button title={`Settings (${shortcutOf("settings")})`} aria-label="Settings" onClick={() => ui().openSettings()}>
          <Gear size={18} />
        </button>
      </nav>
      {left && (
        <aside className="sidebar" style={{ width: sidebarWidth }} aria-label={`${tab} sidebar`} data-focus-region tabIndex={-1}>
          <div className="sidebar-head">
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
          {tab === "notes" && (
            <>
              <div className="tree-toolbar">
                <button aria-label="New note" title={`New note (${shortcutOf("new-note")})`} onClick={() => void newNote(newNoteDir())}>
                  <FilePlus size={15} />
                </button>
                <button
                  aria-label="New…"
                  title="New diagram, drawing, chart or graph"
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
                <button aria-label="Today's note" title={`Open today's daily note (${shortcutOf("daily-note")})`} onClick={() => void openDailyNote()}>
                  <CalendarDays size={15} />
                </button>
                <span className="spacer" />
                <button aria-label="Collapse all folders" title="Collapse all folders" onClick={() => useVault.setState({ expanded: new Set() })}>
                  <ChevronsDownUp size={15} />
                </button>
              </div>
              <FileTree />
            </>
          )}
          {tab !== "notes" && <AreaSidebar destination={tab} />}
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
      {right && contextKind(active) && (
        <div className="right-wrap" style={{ width: rightWidth }}>
          <Resizer
            side="left"
            label="Resize right panel"
            width={rightWidth}
            onResize={(w) => ui().setRightWidth(w)}
            onReset={() => ui().setRightWidth(RIGHT_DEFAULT)}
          />
          <RightPanel key={active} />
        </div>
      )}
      </div>
    </div>
  );
}
