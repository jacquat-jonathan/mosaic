import { useEffect, useId, useRef, useState } from "react";
import { Button, Dialog as SharedDialog, Notice } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./newNoteDialog.css";
import { api } from "../ipc/api";
import { errorMessage, type TemplateList, type TemplatePreview } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { newNotePath, templateRequest } from "../templates";

export function NewNoteDialog() {
  const spec = useUi((s) => s.newNote);
  const root = useVault((s) => s.vault?.root);
  useEffect(() => {
    if (spec && spec.root !== root) useUi.setState({ newNote: null });
  }, [root, spec]);
  return spec && spec.root === root ? (
    <Dialog
      key={`${spec.root}:${spec.dir}:${spec.name}`}
      dir={spec.dir}
      root={spec.root}
      initialName={spec.name}
      newTab={spec.newTab}
    />
  ) : null;
}
function Dialog({
  dir,
  root,
  initialName,
  newTab,
}: {
  dir: string;
  root: string;
  initialName: string;
  newTab: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [folder, setFolder] = useState(dir);
  const [choice, setChoice] = useState("default");
  const [search, setSearch] = useState("");
  const [list, setList] = useState<TemplateList | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [timestamp] = useState(() => {
    // Keep the local offset so Rust and the browser use the same creation date.
    const d = new Date(),
      offset = -d.getTimezoneOffset(),
      sign = offset >= 0 ? "+" : "-";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  });
  const [reload, setReload] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const formId = useId();
  const lock = useRef(false);
  const mounted = useRef(true);
  const current = () => mounted.current && useVault.getState().vault?.root === root;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const entries = useVault((s) => s.entries);
  const revision = useVault((s) => s.revision);
  const close = () => useUi.setState({ newNote: null });
  let path = "",
    validation = "";
  try {
    path = newNotePath(folder, name);
  } catch (e) {
    validation = errorMessage(e);
  }
  if (path && entries.some((e) => e.path.toLowerCase() === path.toLowerCase()))
    validation = `“${path}” already exists. Choose another name.`;
  const request = templateRequest(path, choice, timestamp);
  const previewKey = JSON.stringify([path, choice, timestamp, revision, reload]);
  const [renderedKey, setRenderedKey] = useState("");
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `request` and `previewKey` are derived from the listed values
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    if (!path || validation) return;
    void api
      .templates(path)
      .then((l) => {
        if (active) setList(l);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    void api
      .renderTemplate(request)
      .then((p) => {
        if (active) {
          setPreview(p);
          setRenderedKey(previewKey);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [path, choice, timestamp, revision, reload, validation]);
  const create = async () => {
    if (!preview || renderedKey !== previewKey || lock.current || validation) return;
    if (!current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      // Pin the rendered template choice as well as its hash: concurrent default changes
      // must not silently choose a different source than the preview showed.
      const out = await api.createNote({
        path,
        timestamp,
        template: preview.template,
        blank: !preview.template,
        expected_template_hash: preview.template_hash,
      });
      if (!current()) return;
      await useVault.getState().refresh();
      if (!current()) return;
      useVault.getState().revealParents(out.path);
      useVault.getState().setSelection([out.path]);
      close();
      await useWorkspace.getState().open(out.path, { newTab });
    } catch (e) {
      if (current()) {
        setError(errorMessage(e));
        setPreview(null);
      }
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const templates = list?.templates.filter((t) => t.path.toLowerCase().includes(search.toLowerCase())) ?? [];
  const defaultLabel = list?.default.template
    ? `${list.default.template} · default from ${list.default.rule_folder || "Vault root"}`
    : "Blank · folder default";
  return (
    <DesignSystemScope className="new-note-scope">
      <SharedDialog
        open
        title="New note"
        initialFocusRef={input}
        dismissible={!busy}
        onClose={close}
        actions={
          <>
            <Button disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              type="submit"
              form={formId}
              disabled={!preview || renderedKey !== previewKey || !!validation || busy}
            >
              {busy ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="new-note-fields"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="mds-field">
            Name
            <input
              ref={input}
              className="mds-input"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="mds-field">
            Folder
            <select className="mds-input" value={folder} disabled={busy} onChange={(e) => setFolder(e.target.value)}>
              <option value="">Vault root</option>
              {entries
                .filter((e) => e.is_dir)
                .map((e) => (
                  <option key={e.path} value={e.path}>
                    {e.path}
                  </option>
                ))}
              {folder && !entries.some((e) => e.is_dir && e.path === folder) && (
                <option value={folder}>{folder} (new folder)</option>
              )}
            </select>
          </label>
          <label className="mds-field">
            Find templates
            <input
              className="mds-input"
              value={search}
              disabled={busy}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or path…"
            />
          </label>
          <label className="mds-field">
            Template
            <select className="mds-input" value={choice} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
              <option value="default">Use folder default</option>
              <option value="blank">Blank</option>
              {templates.map((t) => (
                <option key={t.path} value={t.path}>
                  {t.path}
                </option>
              ))}
              {choice !== "default" && choice !== "blank" && !templates.some((t) => t.path === choice) && (
                <option value={choice}>{choice}</option>
              )}
            </select>
          </label>
          <p className="mds-hint">
            {choice === "default"
              ? defaultLabel
              : choice === "blank"
                ? "Blank · chosen for this note"
                : `${choice} · chosen for this note`}
          </p>
          <div className="template-preview" aria-label="Template preview">
            <pre>
              {preview?.content ||
                (preview
                  ? "Empty note"
                  : validation
                    ? "Enter a valid, available name to preview."
                    : error
                      ? "Choose another template or refresh the preview."
                      : "Preview loading…")}
            </pre>
          </div>
          {(validation || error) && (
            <Notice tone="error" role="alert">
              {validation || error}
            </Notice>
          )}
          {error && (
            <Button disabled={busy} onClick={() => setReload((n) => n + 1)}>
              Refresh preview
            </Button>
          )}
        </form>
      </SharedDialog>
    </DesignSystemScope>
  );
}
