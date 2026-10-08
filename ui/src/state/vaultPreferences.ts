import { create } from "zustand";
import { api } from "../ipc/api";
import { prefs } from "./settings";
import { errorMessage } from "../ipc/types";

export interface VaultPreferences {
  version: number;
  agents_folder: string;
  daily_folder: string;
  daily_template: string;
  daily_format: "YYYY-MM-DD" | "DD-MM-YYYY" | "YYYYMMDD";
  new_note_location: "current" | "root" | "folder";
  new_note_folder: string;
  attachment_location: "next-to-note" | "folder";
  attachment_folder: string;
  link_style: "wiki" | "markdown";
  startup_note: string;
  folder_colors: Record<string, string>;
  legacy_migrated?: boolean;
}
export const DEFAULT_VAULT_PREFS: VaultPreferences = {
  version: 1, agents_folder: "Agents", daily_folder: "Daily", daily_template: "", daily_format: "YYYY-MM-DD",
  new_note_location: "current", new_note_folder: "", attachment_location: "next-to-note", attachment_folder: "",
  link_style: "wiki", startup_note: "", folder_colors: {},
};
export const useVaultPreferences = create<{ root: string | null; value: VaultPreferences; error: string | null }>(() => ({ root: null, value: DEFAULT_VAULT_PREFS, error: null }));
export const vaultPrefs = () => useVaultPreferences.getState().value;
let generation = 0;
export async function loadVaultPreferences(root: string) {
  const ticket = ++generation;
  if (useVaultPreferences.getState().root !== root) useVaultPreferences.setState({ root, value: DEFAULT_VAULT_PREFS, error: null });
  try {
    let value = await api.vaultPreferences();
    if (ticket !== generation) return;
    if (!value.legacy_migrated) {
      const legacy = prefs();
      await api.setVaultPreferences(root, { daily_folder: legacy.dailyFolder, daily_template: legacy.dailyTemplate, new_note_location: legacy.newNoteLocation, legacy_migrated: true });
      value = await api.vaultPreferences();
    }
    if (ticket === generation) useVaultPreferences.setState({ value, error: null });
  } catch (e) {
    if (ticket === generation) useVaultPreferences.setState({ error: errorMessage(e) });
  }
}
export async function saveVaultPreferences(patch: Partial<VaultPreferences>) {
  const { root } = useVaultPreferences.getState();
  if (!root) throw new Error("Open a vault first");
  await api.setVaultPreferences(root, patch);
  const value = await api.vaultPreferences();
  if (useVaultPreferences.getState().root === root) useVaultPreferences.setState({ value });
}
