import type { TemplateConfig, TemplateRequest } from "./ipc/types";

export const defaultTemplateConfig = (): TemplateConfig => ({ version: 1, folder: "Templates", rules: [] });
export const inFolder = (path: string, folder: string) => !folder || path.toLowerCase() === folder.toLowerCase() || path.toLowerCase().startsWith(`${folder.toLowerCase()}/`);
export function templateDefault(config: TemplateConfig, path: string) {
  if (inFolder(path, config.folder)) return { template: null, rule_folder: null };
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const rule = config.rules.filter(r => inFolder(parent, r.folder)).sort((a,b) => b.folder.length-a.folder.length)[0];
  return { template: rule?.template ?? null, rule_folder: rule?.folder ?? null };
}
export function newNotePath(folder: string, name: string): string {
  const n = name.trim().replace(/\.md$/i, "");
  if (!n || /[\\/\u0000-\u001f]/.test(n) || n.startsWith(".") || n === "..") throw new Error("Enter a note name without slashes or a leading dot.");
  return `${folder ? folder + "/" : ""}${n}.md`;
}
export function templateRequest(path: string, choice: string, timestamp: string): TemplateRequest {
  return { path, timestamp, template: choice !== "default" && choice !== "blank" ? choice : null, blank: choice === "blank" };
}
