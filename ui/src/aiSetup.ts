import type { CliInfo } from "./ipc/types";

/** Prefer the bundled absolute path: a user-scoped server must work outside this project
 * and in clients that don't inherit a terminal's PATH. Never pin it to the current vault. */
export function aiSetup(info: CliInfo | null) {
  const bin = info?.path ?? "mosaic";
  const quoted = /^[a-zA-Z0-9_./-]+$/.test(bin) ? bin : `'${bin.replace(/'/g, "'\\''")}'`;
  return {
    claudeCode: `claude mcp add --scope user mosaic -- ${quoted} mcp`,
    desktop: JSON.stringify({ mcpServers: { mosaic: { command: bin, args: ["mcp"] } } }, null, 2),
  };
}
