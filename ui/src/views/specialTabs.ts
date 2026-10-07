// Reserved workspace routes; file paths never contain this prefix.
export const CALENDAR_TAB = "mosaic:calendar";
export const isSpecialTab = (path: string) => path.startsWith("mosaic:");
export const viewPath = (kind: string, id?: string) => `mosaic:${kind}${id ? `/${encodeURIComponent(id)}` : ""}`;
export function parseView(path: string): { kind: string; id: string } {
  const [kind, ...rest] = path.slice(7).split("/");
  try { return { kind, id: decodeURIComponent(rest.join("/")) }; } catch { return { kind, id: "" }; }
}
const names: Record<string, string> = { calendar: "Calendar", today: "Today", tasks: "Tasks", week: "My week", overdue: "Overdue", projects: "Project tasks", search: "Search", query: "Query", chat: "Chat", chats: "Chats", agents: "Agents", workflows: "Workflows", workflow: "Workflow", "new-workflow": "Create workflow", run: "Run", runs: "Runs", activity: "AI activity", connections: "Connections", settings: "Settings", planning: "Planning view" };
export const specialTabName = (path: string) => { const { kind, id } = parseView(path); return `${names[kind] ?? kind}${id && ["workflow", "run", "planning"].includes(kind) ? ` · ${id}` : ""}`; };
export function contextKind(path: string | null): "note" | "chat" | "workflow" | "run" | "calendar" | null {
  if (!path) return null;
  if (!isSpecialTab(path)) return "note";
  const { kind } = parseView(path);
  if (["calendar", "today", "week"].includes(kind)) return "calendar";
  return kind === "chat" || kind === "workflow" || kind === "run" ? kind : null;
}
