// Typed access to the backend. Inside Tauri this goes through `invoke`; in a plain browser (UI
// development and tests) it falls back to an in-memory mock vault.

import type { Entry, FileContent, VaultInfo, Written } from "./types";
import { mockInvoke } from "./mock";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  return mockInvoke(cmd, args) as Promise<T>;
}

export const api = {
  openVault: (path: string) => call<VaultInfo>("open_vault", { path }),
  currentVault: () => call<VaultInfo | null>("current_vault"),
  lastVault: () => call<string | null>("last_vault"),
  list: (dir = "", recursive = false) => call<Entry[]>("list_dir", { dir, recursive }),
  read: (path: string) => call<FileContent>("read_file", { path }),
  create: (path: string, content = "") => call<Written>("create_file", { path, content }),
  write: (path: string, content: string, expectedHash?: string | null) =>
    call<Written>("write_file", { path, content, expectedHash: expectedHash ?? null }),
  mkdir: (path: string) => call<void>("make_dir", { path }),
  rename: (from: string, to: string) => call<string>("rename_path", { from, to }),
  remove: (path: string) => call<void>("delete_path", { path }),
  absolutePath: (path: string) => call<string>("absolute_path", { path }),
};

/** Asks the user for a folder with the native dialog (or a prompt-free mock in the browser). */
export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return "/mock/vault";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Open a folder as a vault" });
  return typeof picked === "string" ? picked : null;
}

/** URL the webview can load a vault file from (images, PDF). */
export async function fileUrl(path: string): Promise<string> {
  if (!inTauri) return mockFileUrl(path);
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(await api.absolutePath(path));
}

function mockFileUrl(path: string): string {
  return `/mock-files/${path}`;
}
