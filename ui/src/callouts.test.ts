import { expect, test } from "vitest";
import { parseCalloutHeader } from "./callouts";

test("a callout header gives its kind, title and marker range", () => {
  const h = parseCalloutHeader("> [!warning] Mind the gap")!;
  expect(h).toMatchObject({ kind: "warning", type: "warning", title: "Mind the gap", defaultTitle: "Warning" });
  expect("> [!warning] Mind the gap".slice(h.markerFrom, h.markerTo)).toBe("[!warning] ");
  expect(parseCalloutHeader(">[!info]")).toMatchObject({ kind: "info", title: "", markerFrom: 1, markerTo: 8 });
});

test("types are case-insensitive, with Obsidian and GitHub aliases and fold signs", () => {
  expect(parseCalloutHeader("> [!NOTE]")?.kind).toBe("note");
  expect(parseCalloutHeader("> [!tip] Try this")?.kind).toBe("success");
  expect(parseCalloutHeader("> [!danger]")?.kind).toBe("error");
  expect(parseCalloutHeader("> [!caution]")?.kind).toBe("warning");
  expect(parseCalloutHeader("> [!faq]- Folded")).toMatchObject({ kind: "info", title: "Folded" });
});

test("custom and unknown types are neutral panels named after their title or type", () => {
  expect(parseCalloutHeader("> [!custom] 🚀 Launch")).toMatchObject({ kind: "custom", title: "🚀 Launch" });
  expect(parseCalloutHeader("> [!custom]")?.defaultTitle).toBe("Panel");
  expect(parseCalloutHeader("> [!recipe]")).toMatchObject({ kind: "custom", defaultTitle: "Recipe" });
});

test("other lines aren't callouts", () => {
  for (const line of ["> plain quote", "[!info] not quoted", "> > [!info] nested", "> [!] empty", "> [ !info]"])
    expect(parseCalloutHeader(line)).toBeNull();
});
