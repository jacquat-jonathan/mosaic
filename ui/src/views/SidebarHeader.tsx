import { useEffect, useRef, useState } from "react";
import { ChevronDown, PanelLeftClose } from "lucide-react";
import { Button, IconButton, Notice } from "../design-system/components";
import { api, revealInFinder } from "../ipc/api";
import { errorMessage } from "../ipc/types";
import { createVault, openVaultFolder } from "../actions";
import { shortcutOf } from "../commands";
import { useUi, type MenuItem } from "../state/ui";
import { useVault } from "../state/vault";
import { DesignSystemScope } from "./DesignSystemScope";
import "./sidebarNavigation.css";

export function SidebarHeader({ vault }: { vault: { root: string; name: string } }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const menu = useUi((state) => state.menu),
    prompt = useUi((state) => state.prompt),
    confirm = useUi((state) => state.confirm),
    picker = useUi((state) => state.picker);
  const current = () => mounted.current && useVault.getState().vault?.root === vault.root;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!busy && !menu && !prompt && !confirm && !picker && opener.current) {
      if (opener.current.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [busy, menu, prompt, confirm, picker]);
  const act = async (work: () => Promise<unknown>, vaultAction = false) => {
    if (!current() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem(null);
    if (vaultAction) useVault.getState().setError(null);
    try {
      await work();
      if (current() && vaultAction) setProblem(useVault.getState().error);
    } catch (cause) {
      if (current()) setProblem(errorMessage(cause));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const showMenu = async (button: HTMLButtonElement) => {
    if (!current() || lock.current) return;
    lock.current = true;
    opener.current = button;
    setBusy(true);
    setProblem(null);
    try {
      const recent = await api.recentVaults();
      if (!current() || !button.isConnected) return;
      const others = recent.filter((entry) => entry.root !== vault.root);
      const items: MenuItem[] = [
        ...recent.map<MenuItem>((entry) => ({
          label: entry.name,
          detail: entry.exists ? entry.root.replace(/^\/Users\/[^/]+/, "~") : "Folder not found",
          checked: entry.root === vault.root,
          disabled: !entry.exists,
          action: () => {
            if (entry.root !== vault.root) void act(() => useVault.getState().openVault(entry.root), true);
          },
        })),
        { label: "", separator: true },
        { label: "Open folder as vault…", action: () => void act(() => openVaultFolder(current), true) },
        { label: "Create new vault…", action: () => void act(() => createVault(current), true) },
        { label: "", separator: true },
        { label: "Reveal vault in Finder", action: () => void act(() => revealInFinder("")) },
        ...(others.length
          ? [
              {
                label: "Remove from list",
                children: others.map<MenuItem>((entry) => ({
                  label: entry.name,
                  detail: entry.exists ? undefined : "Folder not found",
                  action: () => void act(() => api.forgetVault(entry.root)),
                })),
              },
            ]
          : []),
      ];
      const bounds = button.getBoundingClientRect();
      useUi.getState().showMenu(bounds.left, bounds.bottom + 4, items);
    } catch (cause) {
      if (current() && button.isConnected) {
        setProblem(errorMessage(cause));
        const bounds = button.getBoundingClientRect();
        useUi.getState().showMenu(bounds.left, bounds.bottom + 4, [
          { label: "Open folder as vault…", action: () => void act(() => openVaultFolder(current), true) },
          { label: "Create new vault…", action: () => void act(() => createVault(current), true) },
          { label: "Reveal vault in Finder", action: () => void act(() => revealInFinder("")) },
        ]);
      }
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <>
      <DesignSystemScope className="sidebar-head" role="group" aria-label="Vault navigation" aria-busy={busy}>
        <Button
          className="vault-name"
          title={`${vault.root}\nSwitch, open or create a vault`}
          aria-haspopup="menu"
          disabled={busy}
          onClick={(event) => void showMenu(event.currentTarget)}
        >
          <span>{vault.name}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
        <IconButton
          label="Hide sidebar"
          title={`Hide sidebar (${shortcutOf("toggle-left")})`}
          disabled={busy}
          onClick={() => useUi.getState().toggleLeftSidebar()}
        >
          <PanelLeftClose aria-hidden="true" />
        </IconButton>
      </DesignSystemScope>
      {problem && (
        <DesignSystemScope className="sidebar-feedback">
          <Notice tone="error">
            {problem}
            <Button aria-label="Dismiss vault navigation error" onClick={() => setProblem(null)}>
              Dismiss
            </Button>
          </Notice>
        </DesignSystemScope>
      )}
    </>
  );
}
