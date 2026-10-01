import { expect, test } from "vitest";
import { ICONS, ICON_NAMES, iconMarkup } from "./icons";

test("every icon name in the shared format has an icon", () => {
  for (const name of ICON_NAMES) expect(ICONS[name], name).toBeTruthy();
  expect(Object.keys(ICONS).sort()).toEqual([...ICON_NAMES].sort());
});

test("icons render to standalone SVG for exports", () => {
  const svg = iconMarkup("server", "#123456", 32)!;
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain('stroke="#123456"');
  expect(iconMarkup("nope", "#000", 10)).toBeNull();
});
