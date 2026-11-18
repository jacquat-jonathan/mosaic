// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ACCENT_COLORS,
  applyColorTheme,
  COLOR_THEMES,
  HIGH_CONTRAST,
  type PaletteDefinition,
  paletteVariables,
} from "./colorThemes";

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
const contrast = (a: string, b: string) => {
  const values = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

const HEX = /^#[0-9a-f]{6}$/;
const KEYS = ["bg", "side", "text", "muted", "faint", "border", "accent"];
const ACCENTS = ["theme", "blue", "green", "violet", "amber"] as const;

describe("palette completeness", () => {
  it("gives every palette a unique id and name and every color in both schemes", () => {
    expect(new Set(COLOR_THEMES.map((theme) => theme.id)).size).toBe(COLOR_THEMES.length);
    expect(new Set(COLOR_THEMES.map((theme) => theme.name)).size).toBe(COLOR_THEMES.length);
    for (const theme of COLOR_THEMES as readonly PaletteDefinition[]) {
      expect(theme.name.trim(), theme.id).not.toBe("");
      expect(theme.description.trim(), theme.id).not.toBe("");
      for (const mode of ["light", "dark"] as const) {
        expect(Object.keys(theme[mode]).sort(), `${theme.id} ${mode}`).toEqual([...KEYS].sort());
        for (const [key, value] of Object.entries(theme[mode]))
          expect(value, `${theme.id} ${mode} ${key}`).toMatch(HEX);
        if (theme.accents)
          expect(Object.keys(theme.accents[mode]).sort()).toEqual(["amber", "blue", "green", "violet"]);
      }
    }
  });

  it("sets the same variables for every palette, scheme and accent, so switching never leaves stale colors", () => {
    const expected = Object.keys(paletteVariables("classic", false, "theme")).sort();
    for (const theme of COLOR_THEMES)
      for (const dark of [false, true])
        for (const accent of ACCENTS) {
          const values = paletteVariables(theme.id, dark, accent);
          expect(Object.keys(values).sort(), `${theme.id} ${dark} ${accent}`).toEqual(expected);
          for (const value of Object.values(values)) expect(value).not.toBe("");
        }
  });
});

describe("high contrast", () => {
  for (const dark of [false, true])
    for (const accent of ACCENTS) {
      it(`${dark ? "dark" : "light"} with the ${accent} accent meets WCAG AAA for body text`, () => {
        const v = paletteVariables(HIGH_CONTRAST, dark, accent);
        // Every surface text sits on: page, sidebar, hover, selected row and editor selection.
        const surfaces = [v.bg, v["bg-side"], v["bg-hover"], v["bg-active"], v.selection];
        for (const surface of surfaces) {
          expect(surface, "high contrast surfaces are solid so they can be checked").toMatch(HEX);
          expect(contrast(v.fg, surface), `text on ${surface}`).toBeGreaterThanOrEqual(7);
          for (const secondary of [v.muted, v.faint, v.accent, v.danger, v.success, v.review])
            expect(contrast(secondary, surface), `${secondary} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
        for (const surface of [v.bg, v["bg-side"]]) {
          expect(contrast(v.muted, surface)).toBeGreaterThanOrEqual(7);
          expect(contrast(v.accent, surface), "accent text and focus rings").toBeGreaterThanOrEqual(7);
          expect(contrast(v.border, surface), "borders").toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(v["on-accent"], v.accent), "button labels").toBeGreaterThanOrEqual(7);
        expect(contrast(v["on-accent"], v.danger), "danger button labels").toBeGreaterThanOrEqual(4.5);
        for (const tint of [v["warn-bg"], v["err-bg"]]) expect(contrast(v.fg, tint)).toBeGreaterThanOrEqual(7);
      });
    }
});

describe("color theme readability", () => {
  for (const theme of COLOR_THEMES)
    for (const mode of ["light", "dark"] as const) {
      it(`${theme.name} ${mode} keeps text, links and button labels readable`, () => {
        const colors = theme[mode];
        for (const background of [colors.bg, colors.side])
          for (const text of [colors.text, colors.muted, colors.accent])
            expect(contrast(background, text), `${background} against ${text}`).toBeGreaterThanOrEqual(4.5);
        for (const accent of [
          colors.accent,
          ...Object.values((theme as PaletteDefinition).accents?.[mode] ?? ACCENT_COLORS[mode]),
        ])
          expect(contrast(accent, mode === "dark" ? colors.bg : "#ffffff")).toBeGreaterThanOrEqual(4.5);
      });
    }
  it("restores every surface and the theme accent when changing palettes or schemes", () => {
    const root = document.createElement("div");
    applyColorTheme(root, "forest", true, "violet");
    expect(root.style.getPropertyValue("--accent")).toBe(ACCENT_COLORS.dark.violet);
    applyColorTheme(root, "paper", false, "theme");
    expect(root.dataset.colorTheme).toBe("paper");
    expect(root.style.getPropertyValue("--bg")).toBe(COLOR_THEMES[1].light.bg);
    expect(root.style.getPropertyValue("--on-accent")).toBe("#ffffff");
    applyColorTheme(root, "classic", true, "theme");
    expect(root.style.getPropertyValue("--bg")).toBe(COLOR_THEMES[0].dark.bg);
    expect(root.style.getPropertyValue("--accent")).toBe(COLOR_THEMES[0].dark.accent);
    expect(root.style.getPropertyValue("--on-accent")).toBe(COLOR_THEMES[0].dark.bg);
  });
  it("applies and then removes the high contrast extras when switching away", () => {
    const root = document.createElement("div");
    applyColorTheme(root, "high-contrast", false, "amber");
    expect(root.dataset.colorTheme).toBe("high-contrast");
    expect(root.style.getPropertyValue("--accent")).toBe("#6b4500");
    expect(root.style.getPropertyValue("--danger")).toBe("#9c1c14");
    expect(root.style.getPropertyValue("--selection")).toBe("#c2d2f5");
    applyColorTheme(root, "high-contrast", true, "theme");
    expect(root.style.getPropertyValue("--on-accent")).toBe("#000000");
    applyColorTheme(root, "classic", false, "amber");
    expect(root.style.getPropertyValue("--accent")).toBe(ACCENT_COLORS.light.amber);
    expect(root.style.getPropertyValue("--danger")).toBe("#d6453d");
    expect(root.style.getPropertyValue("--selection")).toBe("rgba(64, 120, 242, 0.22)");
    expect(root.style.getPropertyValue("--overlay")).toBe("rgba(0, 0, 0, 0.25)");
  });
});
