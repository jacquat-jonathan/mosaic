import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Terminal, X } from "lucide-react";
import { Badge, Button, IconButton, Notice, SettingRow } from "../design-system/components";
import { api } from "../ipc/api";
import {
  errorMessage,
  type AgentRule,
  type AiSetupStatus,
  type CliInfo,
  type DesktopStatus,
  type ProbeResult,
} from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { aiSetup, problemText, removeCommand } from "../aiSetup";
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
    <DesignSystemScope className="connections-settings" role="group" aria-label="Connections and safety">
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
        <div className="connection-cli-status connection-cli-tool" ref={statusRef} tabIndex={-1}>
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
      <AiClients info={info} loading={loading} name={name} />
      <h2>4 · Folder rules for agents</h2>
      <AgentRules root={root} />
      <h2>5 · Workflow chains</h2>
      <WorkflowChainSettings root={root} />
    </>
  );
}
/** Sections 2 and 3: Claude Code and Claude Desktop, with what's registered now and a live check. */
function AiClients({ info, loading, name }: { info: CliInfo | null; loading: boolean; name: string }) {
  const [status, setStatus] = useState<AiSetupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setStatusError(null);
    void api.aiSetupStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      (cause) => {
        if (active) setStatusError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [revision, info?.path]);
  const { claudeCode, desktop } = aiSetup(info);
  if (loading) return null;
  if (!claudeCode || !desktop) {
    return (
      <>
        <h2>2 · Claude Code and Claude Desktop</h2>
        <Notice tone="warning">
          Setup needs the <code>mosaic</code> command inside the app, which this build doesn't include. Open Mosaic from
          your Applications folder, or follow “Connect AI” in the README with the path to an installed Mosaic.app.
        </Notice>
      </>
    );
  }
  const conflicts = (status?.claude_code ?? []).filter((reg) => reg.problems.length > 0);
  return (
    <>
      <h2>2 · Claude Code</h2>
      <p className="mds-hint connection-note">
        Recommended: available in all your projects, private to your user account. It follows the vault selected in
        Mosaic, not the project folder where you start Claude.
      </p>
      <CopyBlock label="Run once in any terminal — all your projects" text={claudeCode} />
      <p className="mds-hint connection-note">
        It replaces an older Mosaic registration for all projects (for example one tied to a vault). Then start a new
        Claude session and check <code>/mcp</code>, or run <code>claude mcp get mosaic</code>. For one project only, run
        it in that project with <code>--scope local</code> instead of <code>--scope user</code>.
      </p>
      {statusError && <Notice tone="error">Couldn't read the current registrations: {statusError}</Notice>}
      {conflicts.length > 0 && (
        <section className="connection-conflicts" aria-label="Other Mosaic registrations in Claude Code">
          <Notice tone="warning">
            Claude Code has {conflicts.length === 1 ? "a Mosaic registration" : "Mosaic registrations"} that can stop it
            from finding this one. A local or project registration wins over the one for all projects.
          </Notice>
          {conflicts.map((reg) => {
            const fix = removeCommand(reg);
            const where = reg.project ? `${reg.scope} registration in ${reg.project}` : "registration for all projects";
            return (
              <div key={`${reg.scope}:${reg.project ?? ""}`} className="connection-conflict">
                <p className="connection-note">
                  <strong>The {where}</strong> runs <code>{[reg.entry.command, ...reg.entry.args].join(" ")}</code>.
                </p>
                <ul className="mds-hint connection-note">
                  {reg.problems.map((problem) => (
                    <li key={problem}>{problemText(problem)}</li>
                  ))}
                </ul>
                {fix ? (
                  <CopyBlock label={`Remove the ${reg.scope} registration`} text={fix} />
                ) : (
                  <p className="mds-hint connection-note">The command above replaces it.</p>
                )}
                {reg.scope === "project" && (
                  <p className="mds-hint connection-note">
                    Project registrations live in that project's shared <code>.mcp.json</code>; check with your team
                    before removing it.
                  </p>
                )}
              </div>
            );
          })}
        </section>
      )}
      <h2>3 · Claude Desktop</h2>
      <DesktopSetup
        status={status?.desktop ?? null}
        json={desktop}
        onChange={(desktopStatus) =>
          setStatus((current) => (current ? { ...current, desktop: desktopStatus } : current))
        }
        onRefresh={() => setRevision((value) => value + 1)}
      />
      <p className="mds-hint connection-note">
        The server always works on the vault open in Mosaic (now “{name}”) and follows when you switch. To tie an agent
        to one vault instead, add <code>--vault "/path/to/vault"</code> before <code>mcp</code>; it then warns the agent
        when Mosaic shows another vault. Switching vaults changes the target of every connected unpinned Mosaic session,
        including sessions already running in other projects. When the app is closed, the server uses the last selected
        vault.
      </p>
      <TestConnection />
    </>
  );
}

function desktopSummary(status: DesktopStatus) {
  switch (status.state.state) {
    case "configured":
      return "Mosaic is set up in Claude Desktop.";
    case "missing":
      return "Claude Desktop has no settings file yet. Adding Mosaic creates it.";
    case "not-configured":
      return "Mosaic isn't in Claude Desktop's settings yet.";
    case "different":
      return `Claude Desktop runs an older Mosaic setup: ${[status.state.entry.command, ...status.state.entry.args].join(" ")}. Update it to follow the vault open in Mosaic.`;
    case "invalid":
      return `Claude Desktop's settings file isn't valid JSON, so Claude Desktop ignores every server in it (${status.state.error}). Fix the file by hand, then check again.`;
  }
}

function DesktopSetup({
  status,
  json,
  onChange,
  onRefresh,
}: {
  status: DesktopStatus | null;
  json: string;
  onChange: (status: DesktopStatus) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState(false);
  const state = status?.state.state;
  const canWrite = state === "missing" || state === "not-configured" || state === "different";
  const write = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.writeClaudeDesktopConfig());
      setWritten(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const path = status?.path ?? "~/Library/Application Support/Claude/claude_desktop_config.json";
  return (
    <>
      {status && (
        <div className="connection-cli-status connection-desktop-status" role="status">
          {state === "configured" && <Badge>Set up</Badge>}
          <span>{desktopSummary(status)}</span>
        </div>
      )}
      {canWrite && (
        <>
          <p className="mds-hint connection-note">
            Quit Claude Desktop first (Claude › Quit), so it doesn't overwrite the change. Your other servers are kept,
            and the previous file is saved next to it as <code>claude_desktop_config.json.bak</code>.
          </p>
          <div className="connection-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void write()}>
              {busy
                ? "Saving…"
                : state === "different"
                  ? "Update Mosaic in Claude Desktop"
                  : "Add Mosaic to Claude Desktop"}
            </Button>
          </div>
        </>
      )}
      {state === "invalid" && (
        <div className="connection-actions">
          <Button variant="secondary" onClick={onRefresh}>
            Check again
          </Button>
        </div>
      )}
      {written && state === "configured" && (
        <p className="mds-hint connection-note" role="status">
          Saved. Open Claude Desktop again; Mosaic appears under “Connectors” in the chat box.
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <CopyBlock label={`Or add by hand to ${path}`} text={json} />
      <p className="mds-hint connection-note">
        Adding by hand: put the <code>mosaic</code> entry inside the existing <code>"mcpServers"</code> (don't paste a
        second <code>"mcpServers"</code>), then quit Claude Desktop completely and open it again.
      </p>
    </>
  );
}

function probeSummary(result: ProbeResult) {
  if (!result.ok) return `The server didn't respond correctly: ${result.error ?? "unknown error"}`;
  const tools = `${result.tools} tools`;
  return result.no_vault
    ? `The server works (${tools}), but no vault opens yet: ${result.no_vault}`
    : `The server works: Claude can connect and use its ${tools}.`;
}

/** Runs the bundled server like Claude Desktop does and reports whether a client could use it. */
function TestConnection() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.testMcpConnection());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Test connection">
      <p className="mds-hint connection-note">
        Test connection starts the server the way Claude does, without your terminal's settings, and checks that it
        answers.
      </p>
      <div className="connection-actions">
        <Button variant="secondary" disabled={busy} onClick={() => void run()}>
          {busy ? "Testing…" : "Test connection"}
        </Button>
      </div>
      {result && (
        <Notice tone={result.ok ? (result.no_vault ? "warning" : "neutral") : "error"}>
          {probeSummary(result)}
          {!result.ok && result.stderr && <pre className="connection-stderr">{result.stderr}</pre>}
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
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
