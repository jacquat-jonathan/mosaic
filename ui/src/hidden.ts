// Hidden (dot-prefixed) files the file tree shows when "Show hidden files and folders" is on.
// The core lists them without walking inside hidden folders and serves them view-only
// (crates/mosaic-core/src/vault.rs, `list_shown` / `read_shown`); `.git/` and `.mosaic/` never appear.

/** Whether a vault path has a hidden segment, such as `.claude/settings.json` or `a/.github`. */
export const isHiddenPath = (path: string) => path.split("/").some((part) => part.startsWith("."));

/** Shown on a hidden file that can't be read now, for example after the setting was turned off. */
export const HIDDEN_FILES_OFF = "Turn on Show hidden files and folders in Settings › Vault folders to view this file.";
