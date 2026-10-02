import type { Version } from "../ipc/types";

/** Who made a change, in words. */
export function who(v: Version): string {
  if (v.action === "before") return v.source === "external" ? "Another app" : "Earlier version";
  if (v.actor) return v.actor;
  return { app: "You", cli: "Command line", agent: "An agent", external: "Another app" }[v.source];
}

/** What happened, in words. */
export function what(v: Version): string {
  if (v.action === "before") return v.source === "external" ? "changed outside Mosaic" : "as it was before";
  if (v.action === "renamed") return `moved from ${v.from_path}`;
  return v.action;
}
