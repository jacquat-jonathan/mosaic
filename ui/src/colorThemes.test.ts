// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ACCENT_COLORS, applyColorTheme, COLOR_THEMES } from "./colorThemes";

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

describe("color theme readability", () => {
  for (const theme of COLOR_THEMES)
    for (const mode of ["light", "dark"] as const) {
      it(`${theme.name} ${mode} keeps text, links and button labels readable`, () => {
        const colors = theme[mode];
        for (const background of [colors.bg, colors.side])
          for (const text of [colors.text, colors.muted, colors.accent])
            expect(contrast(background, text), `${background} against ${text}`).toBeGreaterThanOrEqual(4.5);
        for (const accent of [colors.accent, ...Object.values(ACCENT_COLORS[mode])])
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
});
