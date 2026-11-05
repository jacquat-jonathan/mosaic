import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, RotateCcw } from "lucide-react";
import {
  Button,
  ColorPicker,
  FOLDER_COLOR_OPTIONS,
  IconButton,
  Notice,
  SettingRow,
  SettingsGroup,
  Switch,
  TextField,
} from "../design-system/components";
import { dailyPath } from "../daily";
import { createVault, openVaultFolder } from "../actions";
import { api, revealInFinder } from "../ipc/api";
import { errorMessage } from "../ipc/types";
import { useUi, type Picker } from "../state/ui";
import { useVault } from "../state/vault";
import {
  DEFAULT_VAULT_PREFS,
  saveVaultPreferences,
  useVaultPreferences,
  type VaultPreferences,
} from "../state/vaultPreferences";
import { DesignSystemScope } from "./DesignSystemScope";
import "./vaultFoldersSettings.css";

const FOLDER_KEYS = [
  "agents_folder",
  "daily_notes_enabled",
  "daily_folder",
  "daily_template",
  "daily_format",
  "new_note_location",
  "new_note_folder",
  "attachment_location",
  "attachment_folder",
  "show_attachments_in_tree",
  "folder_colors",
] as const;
type FolderKey = Exclude<
  (typeof FOLDER_KEYS)[number],
  "show_attachments_in_tree" | "folder_colors" | "daily_notes_enabled" | "daily_format"
>;
const CHOICE_LABELS: Record<string, string> = {
  current: "Current file's folder",
  root: "Vault root",
  folder: "Selected folder",
  "next-to-note": "Next to note",
};

function useFolderActions(root: string | null) {
  const loadError = useVaultPreferences((s) => s.error);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const [focusTarget, restoreFocus] = useState<HTMLElement | null>(null);
  const pickerOpener = useRef<HTMLElement | null>(null);
  const picker = useUi((s) => s.picker);
  const errorId = useId();
  const current = () =>
    !!root && useVaultPreferences.getState().root === root && useVault.getState().vault?.root === root;
  useEffect(() => {
    if (!picker && pickerOpener.current) {
      restoreFocus(pickerOpener.current);
      pickerOpener.current = null;
    }
  }, [picker]);
  useEffect(() => {
    if (!busy && !picker && focusTarget) {
      if (focusTarget.isConnected) focusTarget.focus({ preventScroll: true });
      restoreFocus(null);
    }
  }, [busy, picker, focusTarget]);
  const run = async (action: () => Promise<unknown>, repair = false) => {
    if (pending.current || !current() || (useVaultPreferences.getState().error && !repair)) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const save = async (patch: Partial<VaultPreferences>) => {
    const opener = document.activeElement as HTMLElement | null;
    await run(async () => {
      await saveVaultPreferences(patch);
      if (patch.agents_folder !== undefined && current()) await api.mirrorAgents();
    });
    if (current() && opener && !opener.closest('[role="dialog"]')) restoreFocus(opener);
  };
  return {
    busy,
    error: error ?? loadError,
    errorId,
    loadError,
    disabled: busy || !current() || !!loadError,
    ready: current(),
    current,
    run,
    save,
    restoreFocus,
    report: (cause: unknown) => setError(errorMessage(cause)),
    pick: (opener: HTMLElement, spec: Picker) => {
      if (!current() || pending.current || useVaultPreferences.getState().error) return;
      pickerOpener.current = opener;
      useUi.getState().openPicker(spec);
    },
  };
}
type FolderActions = ReturnType<typeof useFolderActions>;

function FolderField({
  name,
  label,
  hint,
  options,
  note = false,
  actions,
}: {
  name: FolderKey;
  label: string;
  hint?: string;
  options?: readonly string[];
  note?: boolean;
  actions: FolderActions;
}) {
  const path = useVaultPreferences((s) => String(s.value[name]));
  const entries = useVault((s) => s.entries);
  const id = useId();
  const missing =
    !options && !!path && !entries.some((entry) => entry.path === path && (note ? !entry.is_dir : entry.is_dir));
  const describedBy =
    [hint && `${id}-hint`, missing && `${id}-missing`, actions.error && actions.errorId].filter(Boolean).join(" ") ||
    undefined;
  return (
    <>
      <SettingRow label={label} hint={hint} controlId={id} hintId={`${id}-hint`}>
        {options ? (
          <select
            id={id}
            className="mds-input"
            value={path}
            aria-describedby={describedBy}
            disabled={actions.disabled}
            onChange={(event) => void actions.save({ [name]: event.target.value })}
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {CHOICE_LABELS[option] ?? option}
              </option>
            ))}
          </select>
        ) : (
          <>
            <Button
              id={id}
              variant="secondary"
              aria-label={label}
              aria-describedby={describedBy}
              disabled={actions.disabled}
              onClick={(event) =>
                actions.pick(event.currentTarget, {
                  placeholder: `Choose ${label.toLowerCase()}`,
                  items: [
                    ...(!note && name !== "agents_folder"
                      ? [{ id: "", label: "Vault root" }]
                      : note
                        ? [{ id: "", label: "None" }]
                        : []),
                    ...entries
                      .filter((entry) => (note ? !entry.is_dir && entry.path.endsWith(".md") : entry.is_dir))
                      .map((entry) => ({ id: entry.path, label: entry.path })),
                  ],
                  onPick: (item) => void actions.save({ [name]: item.id }),
                })
              }
            >
              {path || (note ? "None" : "Vault root")}…
            </Button>
            {!note && (
              <Button
                variant="secondary"
                disabled={actions.disabled}
                aria-label={`Set ${label.toLowerCase()} path`}
                onClick={async (event) => {
                  const opener = event.currentTarget;
                  const next = await useUi.getState().askText({
                    title: `Set ${label.toLowerCase()}`,
                    value: path,
                    placeholder: "Vault-relative folder",
                  });
                  if (next !== null) await actions.save({ [name]: next });
                  actions.restoreFocus(opener);
                }}
              >
                Set path…
              </Button>
            )}
          </>
        )}
        <IconButton
          label={`Reset ${label}`}
          disabled={actions.disabled}
          onClick={() => void actions.save({ [name]: DEFAULT_VAULT_PREFS[name] })}
        >
          <RotateCcw aria-hidden="true" />
        </IconButton>
      </SettingRow>
      {missing && (
        <div id={`${id}-missing`} className="vault-setting-notice">
          <Notice tone="warning">
            Missing: <code>{path}</code>. Choose a replacement
            {!note && (
              <>
                {" "}
                or{" "}
                <Button
                  variant="secondary"
                  disabled={actions.disabled}
                  aria-label={`Create ${label.toLowerCase()}`}
                  onClick={() =>
                    void actions.run(async () => {
                      await api.mkdir(path);
                      if (actions.current()) await useVault.getState().refresh();
                    })
                  }
                >
                  Create folder
                </Button>
              </>
            )}
            .
          </Notice>
        </div>
      )}
    </>
  );
}

function FolderColors({ actions }: { actions: FolderActions }) {
  const colors = useVaultPreferences((s) => s.value.folder_colors);
  const entries = useVault((s) => s.entries);
  const [query, setQuery] = useState("");
  const [pendingColor, setPendingColor] = useState<{ path: string; color: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const id = useId();
  const filter = query.trim().toLowerCase();
  const { children, visible } = useMemo(() => {
    const folders = new Set([
      ...entries.filter((entry) => entry.is_dir).map((entry) => entry.path),
      ...Object.keys(colors),
    ]);
    // Keep saved colors reachable even if a folder or its parent is currently missing.
    for (const path of [...folders]) {
      let parent = path;
      while (parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        folders.add(parent);
      }
    }
    const children = new Map<string, string[]>();
    const visible = new Set<string>();
    for (const path of [...folders].sort((a, b) => a.localeCompare(b))) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const siblings = children.get(parent) ?? [];
      siblings.push(path);
      children.set(parent, siblings);
      if (!filter || path.toLowerCase().includes(filter)) {
        visible.add(path);
        let ancestor = path;
        while (ancestor.includes("/")) {
          ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
          visible.add(ancestor);
        }
      }
    }
    return { children, visible };
  }, [entries, colors, filter]);
  const toggle = (path: string) => {
    const update = (previous: Set<string>) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    };
    if (filter) setSearchCollapsed(update);
    else setExpanded(update);
  };
  const edit = async (path: string, color: string) => {
    if (actions.disabled) return;
    const opener = document.activeElement as HTMLElement | null;
    setPendingColor({ path, color });
    await actions.run(async () => {
      const next = { ...useVaultPreferences.getState().value.folder_colors };
      if (color) next[path] = color;
      else delete next[path];
      await saveVaultPreferences({ folder_colors: next });
    });
    setPendingColor(null);
    if (actions.current() && opener) actions.restoreFocus(opener);
  };
  const renderFolders = (parent: string, depth: number): ReactNode =>
    (children.get(parent) ?? [])
      .filter((path) => visible.has(path))
      .map((path) => {
        const hasChildren = children.get(path)?.some((child) => visible.has(child)) ?? false;
        const open = filter ? !searchCollapsed.has(path) : expanded.has(path);
        const childId = `${id}-${encodeURIComponent(path)}`;
        const label = (
          <>
            <span className="vault-color-chevron" aria-hidden="true">
              {hasChildren && (open ? <ChevronDown /> : <ChevronRight />)}
            </span>
            <Folder aria-hidden="true" />
            <span>{path.split("/").pop()}</span>
          </>
        );
        return (
          <li key={path}>
            <div className="vault-color-row">
              <div className="vault-color-name" style={{ paddingInlineStart: Math.min(depth, 5) * 16 }}>
                {hasChildren ? (
                  <Button
                    className="vault-color-toggle"
                    title={path}
                    aria-label={`${open ? "Collapse" : "Expand"} ${path}`}
                    aria-expanded={open}
                    aria-controls={childId}
                    onClick={() => toggle(path)}
                  >
                    {label}
                  </Button>
                ) : (
                  <span className="vault-color-leaf" title={path}>
                    {label}
                  </span>
                )}
              </div>
              <ColorPicker
                label={`Color for ${path}`}
                value={pendingColor?.path === path ? pendingColor.color : (colors[path] ?? "")}
                options={FOLDER_COLOR_OPTIONS}
                disabled={actions.disabled}
                aria-describedby={actions.error ? actions.errorId : undefined}
                onChange={(color) => void edit(path, color)}
              />
            </div>
            {hasChildren && (
              <ul id={childId} hidden={!open}>
                {open && renderFolders(path, depth + 1)}
              </ul>
            )}
          </li>
        );
      });
  return (
    <SettingsGroup
      title="Folder colors"
      description="Vault-specific · Choose a color for each folder in the file tree."
    >
      <TextField
        label="Filter folders"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSearchCollapsed(new Set());
        }}
        placeholder="Find a folder…"
      />
      <div className="vault-color-list">
        <ul aria-label="Folder colors hierarchy">{renderFolders("", 0)}</ul>
        {!children.size && <p className="mds-hint">Create a folder to assign it a color.</p>}
        {!!children.size && !visible.size && <p className="mds-hint">No matching folders.</p>}
      </div>
    </SettingsGroup>
  );
}

function VaultFolderContents({ root }: { root: string | null }) {
  const vault = useVault((s) => s.vault);
  const preferences = useVaultPreferences((s) => s.value);
  const actions = useFolderActions(root);
  const id = useId();
  return (
    <>
      {vault && (
        <div className="vault-settings-identity">
          <SettingRow label={vault.name} hint={vault.root}>
            <Button
              variant="secondary"
              disabled={actions.busy}
              onClick={() => void revealInFinder("").catch(actions.report)}
            >
              Reveal in Finder
            </Button>
          </SettingRow>
        </div>
      )}
      <SettingRow
        label="Another vault"
        hint="Any folder works, including an existing Obsidian vault. Recent vaults are in the menu under the vault name."
      >
        <Button
          variant="secondary"
          disabled={actions.busy}
          onClick={() => void openVaultFolder().catch(actions.report)}
        >
          Open folder…
        </Button>
        <Button variant="secondary" disabled={actions.busy} onClick={() => void createVault().catch(actions.report)}>
          Create new…
        </Button>
      </SettingRow>
      <p className="mds-hint vault-settings-note">Mosaic keeps its search index and bookmarks outside the vault.</p>
      <p className="mds-hint vault-settings-note">
        Vault-specific · {vault?.name ?? "Open a vault first"}. Changing defaults never moves, deletes, or rewrites
        existing files. Folder creation is always explicit.
      </p>
      {actions.error && (
        <div id={actions.errorId} className="vault-setting-notice">
          <Notice tone="error">
            {actions.error}
            {actions.loadError && (
              <Button
                variant="secondary"
                disabled={actions.busy || !actions.ready}
                onClick={async (event) => {
                  const opener = event.currentTarget;
                  const accepted = await useUi.getState().ask({
                    title: "Repair vault preferences?",
                    body: "Reset known vault preferences to defaults. Unknown fields, all files, permissions and template assignments are preserved. Newer-version settings cannot be downgraded.",
                    confirmLabel: "Reset known preferences",
                  });
                  if (accepted)
                    await actions.run(async () => {
                      await saveVaultPreferences({ ...DEFAULT_VAULT_PREFS, legacy_migrated: true });
                      if (actions.current()) {
                        useVaultPreferences.setState({ error: null });
                        await api.mirrorAgents();
                      }
                    }, true);
                  actions.restoreFocus(opener);
                }}
              >
                Repair…
              </Button>
            )}
          </Notice>
        </div>
      )}
      {actions.busy && (
        <p className="mds-hint vault-settings-note" role="status">
          Updating vault settings…
        </p>
      )}
      <SettingsGroup title="Agents" description="Vault-specific · Agent discovery">
        <FolderField
          actions={actions}
          name="agents_folder"
          label="Agents folder"
          hint="Agent discovery and new workflows use this folder. Existing agents remain in their old folder; generated .claude/skills is separate."
        />
      </SettingsGroup>
      <SettingsGroup
        title="Daily notes"
        description="Vault-specific · Optional dated notes for journaling and reflection. Planning stays in Board and Calendar."
      >
        <SettingRow
          label="Enable daily notes"
          hint="Show daily-note shortcuts and creation options. Existing notes remain accessible in Files and Search."
          controlId={`${id}-daily`}
        >
          <Switch
            id={`${id}-daily`}
            label="Enable daily notes"
            checked={preferences.daily_notes_enabled}
            disabled={actions.disabled}
            onCheckedChange={(checked) => void actions.save({ daily_notes_enabled: checked })}
          />
        </SettingRow>
        {preferences.daily_notes_enabled && (
          <>
            <FolderField
              actions={actions}
              name="daily_folder"
              label="Daily notes folder"
              hint="New daily notes go here. Older daily notes remain discoverable."
            />
            <FolderField
              actions={actions}
              name="daily_template"
              label="Daily note template"
              note
              hint="New daily notes fill {{date}}, {{title}}, {{weekday}} and {{time}}. Date and title remain ISO dates."
            />
            <SettingRow
              label="Daily file name"
              hint="Applies to new notes. Existing files keep their names."
              controlId={`${id}-format`}
            >
              <select
                id={`${id}-format`}
                className="mds-input"
                value={preferences.daily_format}
                disabled={actions.disabled}
                onChange={(event) =>
                  void actions.save({ daily_format: event.target.value as VaultPreferences["daily_format"] })
                }
              >
                {["YYYY-MM-DD", "DD-MM-YYYY", "YYYYMMDD"].map((format) => (
                  <option key={format}>{format}</option>
                ))}
              </select>
              <IconButton
                label="Reset Daily file name"
                disabled={actions.disabled}
                onClick={() => void actions.save({ daily_format: DEFAULT_VAULT_PREFS.daily_format })}
              >
                <RotateCcw aria-hidden="true" />
              </IconButton>
            </SettingRow>
            <p className="mds-hint">
              Preview:{" "}
              <code>{dailyPath(preferences.daily_folder, new Date(2026, 9, 8), preferences.daily_format)}</code>
            </p>
          </>
        )}
      </SettingsGroup>
      <SettingsGroup title="New notes" description="Vault-specific · Default destination">
        <FolderField
          actions={actions}
          name="new_note_location"
          label="New notes go in"
          options={["current", "root", "folder"]}
          hint="Explicit tree and New note dialog destinations take precedence."
        />
        {preferences.new_note_location === "folder" && (
          <FolderField actions={actions} name="new_note_folder" label="New notes folder" />
        )}
      </SettingsGroup>
      <SettingsGroup title="Attachments" description="Vault-specific · Destination and visibility">
        <FolderField
          actions={actions}
          name="attachment_location"
          label="New attachments go in"
          options={["next-to-note", "folder"]}
          hint="Pasted or inserted attachments only; existing files and tree imports are unchanged."
        />
        {preferences.attachment_location === "folder" && (
          <FolderField actions={actions} name="attachment_folder" label="Attachments folder" />
        )}
        <SettingRow
          label="Show attachments in file tree"
          hint="Images and PDFs stay in the vault and remain available from Note details when hidden."
          controlId={id}
          hintId={`${id}-hint`}
        >
          <Switch
            id={id}
            label="Show attachments in file tree"
            aria-describedby={`${id}-hint${actions.error ? ` ${actions.errorId}` : ""}`}
            checked={preferences.show_attachments_in_tree}
            disabled={actions.disabled}
            onCheckedChange={(checked) => void actions.save({ show_attachments_in_tree: checked })}
          />
          <IconButton
            label="Reset Show attachments in file tree"
            disabled={actions.disabled}
            onClick={() =>
              void actions.save({ show_attachments_in_tree: DEFAULT_VAULT_PREFS.show_attachments_in_tree })
            }
          >
            <RotateCcw aria-hidden="true" />
          </IconButton>
        </SettingRow>
      </SettingsGroup>
      <FolderColors actions={actions} />
      <Button
        variant="secondary"
        className="vault-section-reset"
        disabled={actions.disabled}
        onClick={async (event) => {
          const opener = event.currentTarget;
          const accepted = await useUi.getState().ask({
            title: "Reset vault folders?",
            body: `Resets creation and discovery defaults for ${vault?.name}. Existing files, template assignments, permissions and history are kept.`,
            confirmLabel: "Reset section",
          });
          if (accepted)
            await actions.save(Object.fromEntries(FOLDER_KEYS.map((key) => [key, DEFAULT_VAULT_PREFS[key]])));
          actions.restoreFocus(opener);
        }}
      >
        Reset vault folders…
      </Button>
    </>
  );
}

export function VaultFoldersSettings() {
  const root = useVaultPreferences((s) => s.root);
  return (
    <DesignSystemScope className="vault-folders-settings" role="group" aria-label="Vault folder preferences">
      <VaultFolderContents key={root} root={root} />
    </DesignSystemScope>
  );
}
