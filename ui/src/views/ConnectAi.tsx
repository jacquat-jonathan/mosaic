import { useEffect, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { api } from "../ipc/api";
import type { CliInfo } from "../ipc/types";
import { errorMessage } from "../ipc/types";
import { useUi } from "../state/ui";
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

/** Shows how to connect Claude Code / Claude Desktop (MCP) and shell agents (CLI) to this vault. */
export function ConnectAi() {
  const open = useUi((s) => s.connectAi);
  const vault = useVault((s) => s.vault);
  const [info, setInfo] = useState<CliInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) api.cliInfo().then(setInfo, (e) => setError(errorMessage(e)));
  }, [open]);
  if (!open || !vault) return null;
  const close = () => useUi.getState().setConnectAi(false);
  const bin = info?.installed ? "mosaic" : (info?.path ?? "mosaic");
  const quoted = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const claudeCode = `claude mcp add mosaic -- ${quoted(bin)} --vault ${quoted(vault.root)} mcp`;
  const desktop = JSON.stringify({ mcpServers: { mosaic: { command: info?.path ?? "mosaic", args: ["--vault", vault.root, "mcp"] } } }, null, 2);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal connect-ai" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <h2>Connect AI to “{vault.name}”</h2>
        <p>
          AI tools get the same abilities you have — read, search, create, edit, rename and delete notes and canvases — through the{" "}
          <strong>mosaic</strong> MCP server or command line. Everything they change shows up here within a second.
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

        <div className="modal-actions">
          <button onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
