import { useRef, useState } from "react";
import { ArrowRight, FolderOpen, Info, Keyboard, Palette, PenLine, X } from "lucide-react";
import { Button, IconButton, TextField } from "../design-system/components";
import { useUi, type SettingsSection } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { TemplatesSettings } from "./TemplatesSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { EditorFilesSettings } from "./EditorFilesSettings";
import { VaultFoldersSettings } from "./VaultFoldersSettings";
import { DesignSystemScope } from "./DesignSystemScope";
import "./settingsNavigation.css";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { CalendarLinksSettings } from "./CalendarLinksSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { AboutSettings } from "./AboutSettings";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "editor", label: "Editor & files", icon: PenLine },
  { id: "vault", label: "Vault folders", icon: FolderOpen },
  { id: "templates", label: "Templates", icon: PenLine },
  { id: "calendar", label: "Calendar & links", icon: PenLine },
  { id: "workspace", label: "Workspace", icon: FolderOpen },
  { id: "ai", label: "Connections & safety", icon: PenLine },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "about", label: "About & updates", icon: Info },
];

export function Settings() {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const section = useUi((s) => s.settings) ?? "appearance";
  const close = () => {
    const ws = useWorkspace.getState();
    ws.closeTab(ws.focused, "mosaic:settings");
  };
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const matches = SECTIONS.filter((s) =>
    `${s.label} ${SETTING_WORDS[s.id] ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="settings-workspace">
      <div className="settings" role="region" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <DesignSystemScope as="nav" className="settings-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          <TextField
            ref={searchRef}
            label="Search"
            aria-label="Search settings"
            placeholder="Search settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!!query && (
            <div className="settings-search-results" role="region" aria-label="Settings search results">
              {matches.map((s) => (
                <Button
                  key={s.id}
                  onClick={() => {
                    useUi.getState().openSettings(s.id);
                    setQuery("");
                    searchRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <span>{s.label}</span>
                  <ArrowRight aria-hidden="true" />
                </Button>
              ))}
              {matches.length === 0 && <p role="status">No matching settings.</p>}
            </div>
          )}
          {SECTIONS.map((s) => (
            <Button
              key={s.id}
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => useUi.getState().openSettings(s.id)}
            >
              <s.icon aria-hidden="true" /> {s.label}
            </Button>
          ))}
        </DesignSystemScope>
        <section className="settings-body">
          <DesignSystemScope as="header" className="settings-head">
            <h2>{current.label}</h2>
            <IconButton label="Close settings" onClick={close}>
              <X aria-hidden="true" />
            </IconButton>
          </DesignSystemScope>
          <div className="settings-scroll">
            {section === "appearance" && <AppearanceSettings />}
            {section === "editor" && <EditorFilesSettings />}
            {section === "vault" && <VaultFoldersSettings />}
            {section === "templates" && <TemplatesSettings />}
            {section === "calendar" && <CalendarLinksSettings />}
            {section === "workspace" && <WorkspaceSettings />}
            {section === "ai" && (
              <>
                <p className="settings-note">
                  Connection setup and agent permissions live together in the AI workspace. Folder review rules always
                  take precedence over workflow allowances.
                </p>
                <button onClick={() => useUi.getState().openView("connections")}>Open Connections & safety</button>
              </>
            )}
            {section === "shortcuts" && <ShortcutsSettings />}
            {section === "about" && <AboutSettings />}
          </div>
        </section>
      </div>
    </div>
  );
}
const SETTING_WORDS: Partial<Record<SettingsSection, string>> = {
  appearance:
    "theme system light dark note text size width font code font line spacing heading scale accent color interface scale density preview local fallback",
  editor: "spellcheck source line numbers trash confirmation HTML preview scripts vault security",
  vault:
    "agents daily notes folder template new notes attachments folder colors creation discovery current root fixed missing create folder",
  templates: "templates defaults folder assignments rules starters preview",
  calendar: "week starts monday sunday daily file name format new link syntax wiki markdown open note links new tab",
  workspace:
    "startup destination restore previous plan today specific note sidebar context panel visibility default width",
  shortcuts: "keyboard shortcuts bindings",
  about: "version updates download installation CLI release source",
  ai: "connections permissions review safety Claude MCP",
};
