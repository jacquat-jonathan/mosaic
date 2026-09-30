import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, NOTE_SIZE_MAX, sanitize } from "./settings";

describe("settings", () => {
  it("falls back to defaults for missing or malformed storage", () => {
    expect(sanitize(null)).toEqual(DEFAULT_PREFS);
    expect(sanitize("nope")).toEqual(DEFAULT_PREFS);
    expect(sanitize({ theme: "purple", spellcheck: "yes", newNoteLocation: 3 })).toEqual(DEFAULT_PREFS);
  });

  it("keeps valid values and clamps the text size", () => {
    const p = sanitize({ theme: "dark", noteSize: 99, readableWidth: false, confirmTrash: false, newNoteLocation: "root" });
    expect(p).toMatchObject({ theme: "dark", noteSize: NOTE_SIZE_MAX, readableWidth: false, confirmTrash: false, newNoteLocation: "root" });
  });
});
