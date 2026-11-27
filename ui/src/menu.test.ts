// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, rebind, zoom } from "./commands";
import { useFeedback } from "./feedback/store";
import { MENU_COMMANDS, type MenuItemSync } from "./ipc/bindings";
import { menuAccelerator, menuItems, runMenuCommand, startMenu } from "./menu";
import { DEFAULT_PREFS, prefs, useSettings } from "./state/settings";
import { useVault } from "./state/vault";

const openVault = () => useVault.setState({ vault: { root: "/vault", name: "Vault" } } as never);
const item = (id: string) => menuItems().find((i) => i.id === id)!;

afterEach(() => {
  useVault.setState({ vault: null });
  useFeedback.setState({ open: false });
  useSettings.getState().set("shortcuts", {});
  useSettings.getState().set("uiScale", DEFAULT_PREFS.uiScale);
});

describe("menu accelerators", () => {
  it("are ⌘ shortcuts named the way the native menu parses them", () => {
    expect(menuAccelerator({ code: "KeyN", meta: true })).toBe("Cmd+KeyN");
    expect(menuAccelerator({ code: "Backslash", meta: true, shift: true })).toBe("Shift+Cmd+Backslash");
    expect(menuAccelerator({ code: "KeyL", meta: true, alt: true })).toBe("Alt+Cmd+KeyL");
    expect(menuAccelerator({ code: "KeyB", meta: true, alt: true, shift: true })).toBe("Alt+Shift+Cmd+KeyB");
  });

  it("leave out shortcuts without ⌘, which would take keys from typing", () => {
    expect(menuAccelerator({ code: "KeyN" })).toBeNull();
    expect(menuAccelerator({ code: "KeyN", shift: true })).toBeNull();
    expect(menuAccelerator(undefined)).toBeNull();
  });
});

describe("menu items", () => {
  it("are all registry commands", () => {
    const ids = new Set(commands().map((c) => c.id));
    expect(MENU_COMMANDS.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("show the shortcut that applies, including one changed in Settings › Shortcuts", () => {
    expect(item("new-note").accelerator).toBe("Cmd+KeyN");
    useSettings.getState().set("shortcuts", rebind("new-note", { code: "KeyJ", meta: true, alt: true }).shortcuts);
    expect(item("new-note").accelerator).toBe("Alt+Cmd+KeyJ");
    useSettings.getState().set("shortcuts", rebind("new-note", null).shortcuts);
    expect(item("new-note").accelerator).toBeNull();
    expect(item("feedback").accelerator).toBeNull();
  });

  it("are dimmed when their command can't run", () => {
    expect(item("new-note").enabled).toBe(false);
    expect(item("open-vault").enabled).toBe(true);
    expect(item("zoom-in").enabled).toBe(true);
    openVault();
    expect(item("new-note").enabled).toBe(true);
    // Needs a note open.
    expect(item("save").enabled).toBe(false);
  });
});

describe("choosing a menu item", () => {
  it("runs nothing that needs a vault on the Welcome screen", () => {
    runMenuCommand("feedback");
    expect(useFeedback.getState().open).toBe(false);
    openVault();
    runMenuCommand("feedback");
    expect(useFeedback.getState().open).toBe(true);
  });

  it("ignores ids that aren't commands", () => {
    openVault();
    expect(() => runMenuCommand("not-a-command")).not.toThrow();
  });

  it("zooms without a vault", () => {
    runMenuCommand("zoom-in");
    expect(prefs().uiScale).toBe(1.05);
    runMenuCommand("zoom-reset");
    expect(prefs().uiScale).toBe(1);
  });
});

describe("zoom", () => {
  it("steps in whole notches and stops at the interface-scale bounds", () => {
    for (let i = 0; i < 12; i++) zoom(1);
    expect(prefs().uiScale).toBe(1.3);
    zoom(0);
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      zoom(-1);
      seen.push(prefs().uiScale);
    }
    // 0.8999… would be out of bounds and quietly reset to 1.
    expect(seen).toEqual([0.95, 0.9, 0.85, 0.85, 0.85, 0.85]);
  });
});

describe("startMenu", () => {
  it("sends the menu state once per change and runs chosen items", async () => {
    const send = vi.fn((_items: MenuItemSync[]) => Promise.resolve());
    const stop = await startMenu(send);
    expect(send).toHaveBeenCalledTimes(1);
    useSettings.getState().set("noteSize", 17); // nothing the menu shows
    expect(send).toHaveBeenCalledTimes(1);
    openVault();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.lastCall![0].find((i) => i.id === "new-note")!.enabled).toBe(true);

    window.dispatchEvent(new CustomEvent("mock-menu-command", { detail: "feedback" }));
    expect(useFeedback.getState().open).toBe(true);

    stop();
    useVault.setState({ vault: null });
    expect(send).toHaveBeenCalledTimes(2);
    useSettings.getState().set("noteSize", DEFAULT_PREFS.noteSize);
  });
});
