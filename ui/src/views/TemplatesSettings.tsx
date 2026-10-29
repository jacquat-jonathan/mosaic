import { useEffect, useId, useRef, useState } from "react";
import { Badge, Button, Notice, Select, TextField } from "../design-system/components";
import { api } from "../ipc/api";
import { errorMessage, type TemplateConfig, type TemplateList } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { defaultTemplateConfig } from "../templates";
import { DesignSystemScope } from "./DesignSystemScope";
import "./templatesSettings.css";

export function TemplatesSettings() {
  const root = useVault((s) => s.vault?.root);
  return (
    <DesignSystemScope className="template-settings" role="group" aria-label="Template preferences">
      {root ? <Editor key={root} root={root} /> : <Notice>Open a vault to configure templates.</Notice>}
    </DesignSystemScope>
  );
}
function Editor({ root }: { root: string }) {
  const entries = useVault((s) => s.entries),
    revision = useVault((s) => s.revision);
  const [config, setConfig] = useState<TemplateConfig | null>(null);
  const [list, setList] = useState<TemplateList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [starters, setStarters] = useState<[string, string][] | null>(null);
  const pending = useRef(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLButtonElement>(null);
  const returnToPreview = useRef(false);
  const [repairing, setRepairing] = useState(false);
  const id = useId();
  const dirty = useRef(false);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .templateConfig()
      .then((c) => {
        if (active && !dirty.current) {
          setConfig(c);
          setError(null);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    void api
      .templates()
      .then((l) => {
        if (active) {
          setList(l);
          setListError(null);
        }
      })
      .catch((cause) => {
        if (active) setListError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [root, revision, reload]);
  useEffect(() => {
    if (!starters && !busy && returnToPreview.current) {
      const target = previewRef.current;
      (target && !target.disabled ? target : folderRef.current)?.focus({ preventScroll: true });
      returnToPreview.current = false;
    }
  }, [starters, busy]);
  const change = (c: TemplateConfig) => {
    dirty.current = true;
    setChanged(true);
    setConfig(c);
    setMessage(null);
  };
  const guard = () => useVault.getState().vault?.root === root;
  const run = async (action: () => Promise<unknown>) => {
    if (pending.current || !guard()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const save = () =>
    config &&
    run(async () => {
      await api.setTemplateConfig(config);
      if (!guard()) return;
      dirty.current = false;
      setChanged(false);
      setMessage("Template settings saved for this vault.");
      await useVault.getState().refresh();
    });
  const folderExists =
    !!config && entries.some((e) => e.is_dir && e.path.toLowerCase() === config.folder.toLowerCase());
  const createFolder = () =>
    config &&
    run(async () => {
      await api.mkdir(config.folder);
      if (guard()) await useVault.getState().refresh();
    });
  const preview = () =>
    run(async () => {
      const next = await api.templateStarters();
      if (guard()) setStarters(next);
    });
  const install = () =>
    config &&
    starters &&
    !changed &&
    run(async () => {
      const results: string[] = [];
      if (!folderExists) await api.mkdir(config.folder);
      for (const [name, content] of starters) {
        if (!guard()) return;
        const path = `${config.folder}/${name}`;
        try {
          await api.create(path, content, root);
          results.push(`Added ${name}`);
        } catch (cause) {
          if ((cause as { code?: string }).code === "already_exists") results.push(`Kept existing ${name}`);
          else throw cause;
        }
      }
      if (!guard()) return;
      setMessage(results.join(" · "));
      returnToPreview.current = true;
      setStarters(null);
      await useVault.getState().refresh();
    });
  if (!config)
    return error ? (
      <>
        <Notice tone="error">{error}</Notice>
        <div className="template-actions">
          <Button
            variant="secondary"
            onClick={() => {
              setError(null);
              setReload((value) => value + 1);
            }}
          >
            Retry loading template settings
          </Button>
          <Button
            onClick={() => {
              setRepairing(true);
              change(defaultTemplateConfig());
            }}
          >
            Repair template settings
          </Button>
        </div>
      </>
    ) : (
      <Notice>Loading template settings…</Notice>
    );
  const paths = list?.templates.map((template) => template.path) ?? [];
  return (
    <>
      <p className="mds-hint template-settings-note">
        Templates are ordinary Markdown notes. These settings apply to this vault and are shared with AI agents.
      </p>
      <TextField
        ref={folderRef}
        id={`${id}-folder`}
        label="Templates folder"
        list={`${id}-folders`}
        hint="Choose a vault-relative folder. Selecting a location does not create it."
        aria-describedby={
          [error && `${id}-error`, !folderExists && `${id}-missing`].filter(Boolean).join(" ") || undefined
        }
        value={config.folder}
        disabled={busy}
        autoFocus={repairing}
        onChange={(event) => change({ ...config, folder: event.target.value.replace(/^\/+|\/+$/g, "") })}
      />
      <datalist id={`${id}-folders`}>
        {entries
          .filter((entry) => entry.is_dir)
          .map((entry) => (
            <option key={entry.path} value={entry.path} />
          ))}
      </datalist>
      {!folderExists && (
        <div id={`${id}-missing`}>
          <Notice tone="warning">
            The folder is missing. Selecting a location does not create it.{" "}
            <Button variant="secondary" disabled={busy || !config.folder} onClick={() => void createFolder()}>
              Create templates folder
            </Button>
          </Notice>
        </div>
      )}
      <section aria-label="Folder defaults">
        <h3>Folder defaults</h3>
        <p className="mds-hint template-settings-note">
          Subfolders inherit the nearest default. Blank stops inheritance. Removing a rule restores inheritance.
        </p>
        {config.rules.length === 0 && <p className="mds-hint template-empty">No folder defaults yet.</p>}
        {config.rules.map((rule, index) => (
          <fieldset className="template-default-rule" key={index} disabled={busy}>
            <legend>Default {index + 1}</legend>
            <Select
              label="Destination folder"
              value={rule.folder}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) =>
                change({
                  ...config,
                  rules: config.rules.map((current, position) =>
                    position === index ? { ...current, folder: event.target.value } : current,
                  ),
                })
              }
            >
              <option value="">Vault root</option>
              {entries
                .filter((entry) => entry.is_dir)
                .map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.path}
                  </option>
                ))}
              {rule.folder && !entries.some((entry) => entry.is_dir && entry.path === rule.folder) && (
                <option value={rule.folder}>{rule.folder} (missing)</option>
              )}
            </Select>
            <Select
              label="Default template"
              value={rule.template ?? ""}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) =>
                change({
                  ...config,
                  rules: config.rules.map((current, position) =>
                    position === index ? { ...current, template: event.target.value || null } : current,
                  ),
                })
              }
            >
              <option value="">Blank</option>
              {paths.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
              {rule.template && !paths.includes(rule.template) && (
                <option value={rule.template}>{rule.template} (missing or outside Templates folder)</option>
              )}
            </Select>
            <Button
              aria-label={`Remove default for ${rule.folder || "Vault root"}`}
              onClick={() => change({ ...config, rules: config.rules.filter((_, position) => position !== index) })}
            >
              Remove
            </Button>
          </fieldset>
        ))}
        <div className="template-actions">
          <Button
            disabled={busy}
            onClick={() => change({ ...config, rules: [...config.rules, { folder: "", template: null }] })}
          >
            Add folder default
          </Button>
          <Button variant="secondary" disabled={busy || !changed} onClick={() => void save()}>
            Save template settings
          </Button>
          {changed && <Badge>Unsaved changes</Badge>}
        </div>
      </section>
      {busy && (
        <p className="mds-hint template-settings-note" role="status">
          Updating template settings…
        </p>
      )}
      {error && (
        <div id={`${id}-error`}>
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {message && <Notice>{message}</Notice>}
      <section aria-label="Available templates">
        <h3>Available templates</h3>
        {listError ? (
          <Notice tone="error">
            {listError}{" "}
            <Button variant="secondary" disabled={busy} onClick={() => setReload((value) => value + 1)}>
              Refresh templates
            </Button>
          </Notice>
        ) : !list ? (
          <p className="mds-hint template-empty" role="status">
            Loading available templates…
          </p>
        ) : paths.length ? (
          paths.map((path) => (
            <Button
              className="template-source-link"
              key={path}
              onClick={() => {
                if (guard())
                  void useWorkspace
                    .getState()
                    .open(path, { newTab: true })
                    .catch((cause) => setError(errorMessage(cause)));
              }}
            >
              {path}
            </Button>
          ))
        ) : (
          <p className="mds-hint template-empty">No saved Markdown templates in this folder yet.</p>
        )}
        <Button ref={previewRef} variant="secondary" disabled={busy || changed} onClick={() => void preview()}>
          Preview starter templates
        </Button>
        {changed && (
          <p className="mds-hint template-settings-note">Save your settings before adding starter templates.</p>
        )}
      </section>
      {starters && (
        <section className="template-starter-section" aria-label="Starter template previews">
          <h3>Starter templates</h3>
          <p className="mds-hint template-settings-note">
            These become editable notes. Existing filenames will be kept.
          </p>
          {starters.map(([name, content]) => (
            <details key={name}>
              <summary>{name}</summary>
              <pre className="template-starter-preview">{content}</pre>
            </details>
          ))}
          <div className="template-actions">
            <Button
              disabled={busy}
              onClick={() => {
                returnToPreview.current = true;
                setStarters(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="secondary" disabled={busy || changed} onClick={() => void install()}>
              Add starter templates
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
