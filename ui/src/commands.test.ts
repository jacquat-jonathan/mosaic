import { describe, expect, it } from "vitest";
import { commands, formatKeys, matches } from "./commands";
import { filterItems } from "./views/Picker";

const key = (code: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean } = {}) => ({
  code,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  ctrlKey: !!mods.ctrl,
});

describe("command registry", () => {
  it("formats shortcuts like macOS menus", () => {
    expect(formatKeys({ code: "KeyP", meta: true })).toBe("⌘P");
    expect(formatKeys({ code: "KeyB", meta: true, alt: true })).toBe("⌥⌘B");
    expect(formatKeys({ code: "Backslash", meta: true, shift: true })).toBe("⇧⌘\\");
  });

  it("matches on physical keys and exact modifiers", () => {
    const k = { code: "KeyB", meta: true, alt: true };
    expect(matches(k, key("KeyB", { meta: true, alt: true }))).toBe(true);
    expect(matches(k, key("KeyB", { meta: true }))).toBe(false);
    expect(matches(k, key("KeyB", { meta: true, alt: true, shift: true }))).toBe(false);
    expect(matches(k, key("KeyB", { meta: true, alt: true, ctrl: true }))).toBe(false);
  });

  it("has unique ids and no two commands on the same shortcut", () => {
    const list = commands();
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    const keys = list.filter((c) => c.keys).map((c) => formatKeys(c.keys!));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("finds commands by fuzzy text", () => {
    const items = commands().map((c) => ({ id: c.id, label: c.label }));
    expect(filterItems(items, "tgl rght")[0].id).toBe("toggle-right");
    expect(filterItems(items, "new fold")[0].id).toBe("new-folder");
  });
});
