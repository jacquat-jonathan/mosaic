import type { CliInfo, Registration, RegistrationProblem } from "./ipc/types";

/** POSIX shell quoting (zsh/bash: the app is macOS-only). */
export function shellQuote(text: string) {
  return /^[a-zA-Z0-9_./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/** Setup for both Claude clients, from the bundled command's absolute path. Never a bare `mosaic`:
 * Claude Desktop (and Claude Code started outside a terminal) don't have the terminal's PATH. Never
 * pinned to the current vault: the server follows the vault open in the app. `null` without a path. */
export function aiSetup(info: CliInfo | null) {
  const bin = info?.path ?? null;
  if (!bin) return { claudeCode: null, desktop: null };
  return {
    // `claude mcp add` refuses (and keeps the old entry) when `mosaic` already exists, so an older
    // registration (a pinned vault, an old path) is removed first.
    claudeCode: `claude mcp remove --scope user mosaic >/dev/null 2>&1; claude mcp add --scope user mosaic -- ${shellQuote(bin)} mcp`,
    desktop: JSON.stringify({ mcpServers: { mosaic: { command: bin, args: ["mcp"] } } }, null, 2),
  };
}

const PROBLEMS: Record<RegistrationProblem, string> = {
  "shadows-user": "In this folder it replaces the recommended registration for all projects.",
  "pins-vault": "It is tied to one vault (--vault), so it doesn't follow the vault open in Mosaic.",
  "not-absolute": "It runs a bare or relative command, which isn't found when Claude isn't started from a terminal.",
  "command-missing": "Its command no longer exists (an older install location).",
  "other-command": "It runs another program than this Mosaic app's command.",
};

export function problemText(problem: RegistrationProblem) {
  return PROBLEMS[problem];
}

/** The command that removes a local or project registration. A user registration is replaced by
 * the main setup command instead. */
export function removeCommand(reg: Registration) {
  if (reg.scope === "user" || !reg.project) return null;
  return `cd ${shellQuote(reg.project)} && claude mcp remove --scope ${reg.scope} mosaic`;
}
