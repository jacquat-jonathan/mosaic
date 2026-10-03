import { useEffect, useState } from "react";
import { Check, Copy, FolderLock, Terminal, X } from "lucide-react";
import { api } from "../ipc/api";
import type { AgentRule, CliInfo } from "../ipc/types";
import { useUi } from "../state/ui";
import { errorMessage } from "../ipc/types";
import { useVault } from "../state/vault";

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <div className="copy-head">
        <span>{label}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

/** Settings › AI: how to connect Claude Code / Claude Desktop (MCP) and shell agents (CLI) to this vault. */
export function ConnectAiSection() {
  const vault = useVault((s) => s.vault);
  const [info, setInfo] = useState<CliInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.cliInfo().then(setInfo, (e) => setError(errorMessage(e)));
  }, []);
  if (!vault) return null;
  const bin = info?.installed ? "mosaic" : (info?.path ?? "mosaic");
  const quoted = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  // No --vault: the server follows the vault open here, so agents always write where you're looking.
  const claudeCode = `claude mcp add mosaic -- ${quoted(bin)} mcp`;
  const desktop = JSON.stringify({ mcpServers: { mosaic: { command: info?.path ?? "mosaic", args: ["mcp"] } } }, null, 2);

  return (
    <div className="connect-ai">
      <p className="settings-lede">
        AI tools get the same abilities you have in “{vault.name}” — read, search, create, edit, rename and delete notes and
        canvases — through the <strong>mosaic</strong> MCP server or command line. Everything they change shows up here within a
        second.
      </p>

      <h3>1 · Command-line tool</h3>
      {info?.path ? (
        <div className="cli-status">
          <Terminal size={15} />
          {info.installed ? (
            <span>
              Installed as <code>mosaic</code> ({info.link}).
            </span>
          ) : (
            <>
              <span>Link the bundled tool into {info.link} so terminals and agents can run <code>mosaic</code>.</span>
              <button className="primary" onClick={() => api.installCli().then(setInfo, (e) => setError(errorMessage(e)))}>
                Install
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="panel-meta">This build doesn't include the command-line tool (development mode).</p>
      )}
      {error && <p className="error-text">{error}</p>}

      <h3>2 · Claude Code</h3>
      <CopyBlock label="Run in a terminal" text={claudeCode} />

      <h3>3 · Claude Desktop</h3>
      <CopyBlock label="Add to ~/Library/Application Support/Claude/claude_desktop_config.json" text={desktop} />

      <p className="settings-note">
        The server always works on the vault open in Mosaic (now “{vault.name}”) and follows when you switch. To tie an agent to one
        vault instead, add <code>--vault "/path/to/vault"</code> before <code>mcp</code>; it then warns the agent when Mosaic shows
        another vault. If you set Mosaic up before version 0.5, run <code>claude mcp remove mosaic</code>, then the command above, so your agent follows the app.
      </p>

      <h3>4 · Folder rules for agents</h3>
      <AgentRules />
    </div>
  );
}

/** Folders where agents (MCP, CLI) must have changes reviewed, may only read, or can't see at all. Enforced in the core, not by the agent. */
function AgentRules() {
  const [rules, setRules] = useState<AgentRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.agentRules().then(setRules, (e) => setError(errorMessage(e)));
  }, []);
  const save = (next: AgentRule[]) => {
    setRules(next);
    api.setAgentRules(next).catch((e) => setError(errorMessage(e)));
  };
  const add = () => {
    const taken = new Set(rules?.map((r) => r.path));
    const folders = useVault.getState().entries.filter((e) => e.is_dir && !taken.has(e.path));
    useUi.getState().openPicker({
      placeholder: "Which folder should agents treat differently?",
      items: folders.map((f) => ({ id: f.path, label: f.path.split("/").pop()!, detail: f.path.includes("/") ? f.path : undefined })),
      hint: "↵ choose · esc cancel",
      onPick: (item) => save([...(rules ?? []), { path: item.id, access: "review" }]),
    });
  };
  if (!rules) return error ? <p className="error-text">{error}</p> : null;
  return (
    <div className="agent-rules">
      <p className="settings-note">
        <strong>Review changes:</strong> agents' edits, new files and deletions wait for you under AI activity, where you see each
        change and accept or reject it; nothing changes until you do. <strong>Read-only:</strong> agents can read and search it but
        not change, move or delete anything. <strong>Hidden:</strong> agents can't see it at all: it's left out of listings, search
        and backlinks. This applies to the MCP server and the <code>mosaic</code> command, never to you.
      </p>
      {rules.map((r, i) => (
        <div key={r.path} className="agent-rule">
          <FolderLock size={14} />
          <code>{r.path}</code>
          <span className="spacer" />
          <select value={r.access} aria-label={`Access for ${r.path}`} onChange={(e) => save(rules.map((x, j) => (j === i ? { ...x, access: e.target.value as AgentRule["access"] } : x)))}>
            <option value="review">Review changes</option>
            <option value="read-only">Read-only</option>
            <option value="hidden">Hidden</option>
          </select>
          <button className="icon" aria-label={`Remove the rule for ${r.path}`} title="Remove" onClick={() => save(rules.filter((_, j) => j !== i))}>
            <X size={14} />
          </button>
        </div>
      ))}
      <button className="secondary" onClick={add}>
        Add a folder…
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
