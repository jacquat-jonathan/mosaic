import { expect, test } from "vitest";
import { ICONS, ICON_NAMES, iconMarkup } from "./icons";
import format from "../../../crates/mosaic-core/src/diagram_format.json";

test("every icon name in the shared format has an icon", () => {
  for (const name of ICON_NAMES) expect(ICONS[name], name).toBeTruthy();
  expect(Object.keys(ICONS).sort()).toEqual([...ICON_NAMES].sort());
});

test("the format file's icon SVG (used by the Rust renderer) matches the bundled icons", () => {
  for (const name of ICON_NAMES) {
    const inner = iconMarkup(name, "currentColor", 24)!.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    expect(inner, name).toBe((format.icons as Record<string, string>)[name]);
  }
});

test("icons render to standalone SVG for exports", () => {
  const svg = iconMarkup("server", "#123456", 32)!;
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain('stroke="#123456"');
  expect(iconMarkup("nope", "#000", 10)).toBeNull();
});
