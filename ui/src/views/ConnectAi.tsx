import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Terminal, X } from "lucide-react";
import { Badge, Button, IconButton, Notice, SettingRow } from "../design-system/components";
import { api } from "../ipc/api";
import { errorMessage, type AgentRule, type CliInfo } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { aiSetup } from "../aiSetup";
import { DesignSystemScope } from "./DesignSystemScope";
import "./connectionsSettings.css";

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <section className="connection-copy" aria-label={label}>
      <div className="connection-copy-head">
        <span>{label}</span>
        <Button
          variant="secondary"
          aria-label={`Copy ${label}`}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            setCopied(false);
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(text))
              .then(
                () => {
                  setCopied(true);
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(() => setCopied(false), 1500);
                },
                (cause) => setError(errorMessage(cause)),
              )
              .finally(() => setBusy(false));
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre tabIndex={0}>{text}</pre>
      {copied && (
        <p className="mds-hint connection-note" role="status">
          Copied to clipboard.
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

const RULES = { read: () => api.agentRules(), write: (next: AgentRule[]) => api.setAgentRules(next) };
const DEPTH = {
  read: async () => (await api.tesseraStatus()).max_chain_depth,
  write: (next: number) => api.tesseraSetMaxChainDepth(next),
};
function useVaultValue<T>(root: string, source: { read(): Promise<T>; write(next: T): Promise<unknown> }) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [focusTarget, restoreFocus] = useState<HTMLElement | null>(null);
  const pending = useRef(false);
  const errorId = useId();
  const current = useCallback(() => useVault.getState().vault?.root === root, [root]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void source
      .read()
      .then(
        (next) => {
          if (active && current()) {
            setValue(next);
            setUnavailable(false);
          }
        },
        (cause) => {
          if (active && current()) {
            setError(errorMessage(cause));
            setUnavailable(true);
          }
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [current, source, revision]);
  useEffect(() => {
    if (!busy && focusTarget) {
      if (focusTarget.isConnected) focusTarget.focus({ preventScroll: true });
      restoreFocus(null);
    }
  }, [busy, focusTarget]);
  const save = async (next: T, opener?: HTMLElement | null) => {
    if (pending.current || loading || unavailable || !current()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    if (opener) restoreFocus(opener);
    let written = false;
    try {
      await source.write(next);
      if (!current()) return;
      written = true;
      setValue(next);
      const saved = await source.read();
      if (current()) setValue(saved);
    } catch (cause) {
      if (current()) {
        setError(errorMessage(cause));
        if (written) setUnavailable(true);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return {
    value,
    error,
    errorId,
    busy,
    loading,
    unavailable,
    disabled: busy || loading || unavailable || !current(),
    save,
    restoreFocus,
    retry: () => setRevision((value) => value + 1),
  };
}

export function ConnectAiSection() {
  const vault = useVault((state) => state.vault);
  return (
    <DesignSystemScope className="workspace-page connections-settings" role="group" aria-label="Connections and safety">
      <h1>Connections</h1>
      {vault ? (
        <ConnectionDetails key={vault.root} root={vault.root} name={vault.name} />
      ) : (
        <Notice>Open a vault to configure connections and agent safety.</Notice>
      )}
    </DesignSystemScope>
  );
}
function ConnectionDetails({ root, name }: { root: string; name: string }) {
  const [info, setInfo] = useState<CliInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const installRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!busy && returnFocus.current) {
      (installRef.current ?? statusRef.current)?.focus({ preventScroll: true });
      returnFocus.current = false;
    }
  }, [busy]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .cliInfo()
      .then(
        (next) => {
          if (active) setInfo(next);
        },
        (cause) => {
          if (active) setError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const install = async () => {
    if (pending.current) return;
    pending.current = true;
    returnFocus.current = true;
    setBusy(true);
    setError(null);
    try {
      setInfo(await api.installCli());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const { claudeCode, desktop } = aiSetup(info);
  return (
    <>
      <p className="connection-lede">
        AI tools get the same abilities you have in “{name}” — read, search, create, edit, rename and delete notes and
        canvases — through the <strong>mosaic</strong> MCP server or command line. Everything they change shows up here
        within a second.
      </p>
      <h2>1 · Command-line tool</h2>
      {loading ? (
        <Notice>Checking command-line tool…</Notice>
      ) : info?.path ? (
        <div className="connection-cli-status" ref={statusRef} tabIndex={-1}>
          <Terminal aria-hidden="true" />
          {info.installed ? (
            <>
              <Badge>Installed</Badge>
              <span>
                Available as <code>mosaic</code> ({info.link}).
              </span>
            </>
          ) : (
            <>
              <span>
                Link the bundled tool into {info.link} so terminals and agents can run <code>mosaic</code>.
              </span>
              <Button ref={installRef} variant="secondary" disabled={busy} onClick={() => void install()}>
                {busy ? "Installing…" : "Install"}
              </Button>
            </>
          )}
        </div>
      ) : (
        !error && <Notice>This build doesn't include the command-line tool (development mode).</Notice>
      )}
      {error && (
        <Notice tone="error">
          {error}
          {!info && (
            <>
              {" "}
              <Button variant="secondary" onClick={() => setRevision((value) => value + 1)}>
                Retry command-line status
              </Button>
            </>
          )}
        </Notice>
      )}
      <h2>2 · Claude Code</h2>
      <p className="mds-hint connection-note">
        Recommended: available in all your projects, private to your user account. It follows the vault selected in
        Mosaic, not the project folder where you start Claude.
      </p>
      <CopyBlock label="Run once in any terminal — all your projects" text={claudeCode} />
      <p className="mds-hint connection-note">
        Start a new Claude session and check <code>/mcp</code>. An existing local or project registration named{" "}
        <code>mosaic</code> takes priority over this user registration. Remove or update that older registration in its
        project if it pins a vault. For project-only setup, replace <code>--scope user</code> with{" "}
        <code>--scope local</code>.
      </p>
      <h2>3 · Claude Desktop</h2>
      <CopyBlock label="Add to ~/Library/Application Support/Claude/claude_desktop_config.json" text={desktop} />
      <p className="mds-hint connection-note">
        The server always works on the vault open in Mosaic (now “{name}”) and follows when you switch. To tie an agent
        to one vault instead, add <code>--vault "/path/to/vault"</code> before <code>mcp</code>; it then warns the agent
        when Mosaic shows another vault. Switching vaults changes the target of every connected unpinned Mosaic session,
        including sessions already running in other projects. When the app is closed, the server uses the last selected
        vault.
      </p>
      <h2>4 · Folder rules for agents</h2>
      <AgentRules root={root} />
      <h2>5 · Workflow chains</h2>
      <WorkflowChainSettings root={root} />
    </>
  );
}
function WorkflowChainSettings({ root }: { root: string }) {
  const depth = useVaultValue(root, DEPTH);
  const id = useId();
  return (
    <>
      <SettingRow
        label="Maximum agent-generated depth"
        controlId={id}
        hintId={`${id}-hint`}
        hint="An event workflow may create a note that triggers another workflow. Mosaic tracks the chain, prevents repeated workflow/event/note cycles, and stops after this depth. Use 0 to prevent agent-originated chains."
      >
        <select
          id={id}
          className="mds-input"
          aria-label="Maximum workflow chain depth"
          aria-describedby={`${id}-hint${depth.error ? ` ${depth.errorId}` : ""}`}
          disabled={depth.disabled}
          value={depth.value ?? 0}
          onChange={(event) => void depth.save(Number(event.target.value), event.currentTarget)}
        >
          {Array.from({ length: 11 }, (_, value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </SettingRow>
      {depth.loading && <Notice>Loading workflow chain settings…</Notice>}
      {depth.busy && (
        <p className="mds-hint connection-note" role="status">
          Saving workflow chain depth…
        </p>
      )}
      {depth.error && (
        <div id={depth.errorId}>
          <Notice tone="error">
            {depth.error}
            {depth.unavailable && (
              <>
                {" "}
                <Button variant="secondary" disabled={depth.loading} onClick={depth.retry}>
                  Retry workflow chain settings
                </Button>
              </>
            )}
          </Notice>
        </div>
      )}
    </>
  );
}
function AgentRules({ root }: { root: string }) {
  const rules = useVaultValue(root, RULES);
  const entries = useVault((state) => state.entries);
  const picker = useUi((state) => state.picker);
  const addRef = useRef<HTMLButtonElement>(null);
  const pickerOpener = useRef<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (!picker && pickerOpener.current) {
      rules.restoreFocus(pickerOpener.current);
      pickerOpener.current = null;
    }
  }, [picker, rules.restoreFocus]);
  const folders = entries.filter((entry) => entry.is_dir && !rules.value?.some((rule) => rule.path === entry.path));
  return (
    <section aria-label="Agent folder rules">
      <p className="mds-hint connection-note">
        <strong>Review changes:</strong> agents' edits, new files and deletions wait for you under AI activity, where
        you see each change and accept or reject it; nothing changes until you do. <strong>Read-only:</strong> agents
        can read and search it but not change, move or delete anything. <strong>Hidden:</strong> agents can't see it at
        all: it's left out of listings, search and backlinks. This applies to the MCP server and the <code>mosaic</code>{" "}
        command, never to you.
      </p>
      {rules.loading && <Notice>Loading folder rules…</Notice>}
      {rules.value?.length === 0 && <p className="mds-hint connection-note">No folder rules yet.</p>}
      {rules.value?.map((rule, index) => (
        <SettingRow key={rule.path} label={rule.path} controlId={`${id}-${index}`}>
          <select
            id={`${id}-${index}`}
            className="mds-input"
            value={rule.access}
            aria-label={`Access for ${rule.path}`}
            aria-describedby={rules.error ? rules.errorId : undefined}
            disabled={rules.disabled}
            onChange={(event) =>
              void rules.save(
                rules.value!.map((current, position) =>
                  position === index ? { ...current, access: event.target.value as AgentRule["access"] } : current,
                ),
                event.currentTarget,
              )
            }
          >
            <option value="review">Review changes</option>
            <option value="read-only">Read-only</option>
            <option value="hidden">Hidden</option>
          </select>
          <IconButton
            label={`Remove the rule for ${rule.path}`}
            disabled={rules.disabled}
            onClick={() =>
              void rules.save(
                rules.value!.filter((_, position) => position !== index),
                addRef.current,
              )
            }
          >
            <X aria-hidden="true" />
          </IconButton>
        </SettingRow>
      ))}
      <Button
        ref={addRef}
        variant="secondary"
        disabled={rules.disabled || !folders.length}
        aria-describedby={rules.error ? rules.errorId : undefined}
        onClick={(event) => {
          pickerOpener.current = event.currentTarget;
          useUi.getState().openPicker({
            placeholder: "Which folder should agents treat differently?",
            items: folders.map((folder) => ({
              id: folder.path,
              label: folder.path.split("/").pop()!,
              detail: folder.path.includes("/") ? folder.path : undefined,
            })),
            hint: "↵ choose · esc cancel",
            onPick: (item) => void rules.save([...(rules.value ?? []), { path: item.id, access: "review" }]),
          });
        }}
      >
        Add a folder…
      </Button>
      {!rules.disabled && !folders.length && (
        <p className="mds-hint connection-note">No more folders are available to add.</p>
      )}
      {rules.busy && (
        <p className="mds-hint connection-note" role="status">
          Saving folder rules…
        </p>
      )}
      {rules.error && (
        <div id={rules.errorId}>
          <Notice tone="error">
            {rules.error}
            {rules.unavailable && (
              <>
                {" "}
                <Button variant="secondary" disabled={rules.loading} onClick={rules.retry}>
                  Retry folder rules
                </Button>
              </>
            )}
          </Notice>
        </div>
      )}
    </section>
  );
}
