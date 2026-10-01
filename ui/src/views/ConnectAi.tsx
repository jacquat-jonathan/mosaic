import { useEffect, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { api } from "../ipc/api";
import type { CliInfo } from "../ipc/types";
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
    </div>
  );
}
