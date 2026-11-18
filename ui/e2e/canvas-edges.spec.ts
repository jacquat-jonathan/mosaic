import { expect, test, type Page } from "@playwright/test";
import { openMockVault } from "./mock-vault";

// A connection whose line crosses a card, all inside a group: the line, its arrowhead and its label
// must draw over cards, and the group must stay behind everything.
const CANVAS = {
  nodes: [
    { id: "g", type: "group", x: -60, y: -120, width: 780, height: 380, label: "Group" },
    { id: "a", type: "text", x: 0, y: 0, width: 160, height: 90, text: "Source" },
    { id: "mid", type: "text", x: 230, y: -60, width: 160, height: 210, text: "In the way" },
    { id: "b", type: "text", x: 460, y: 0, width: 160, height: 90, text: "Target" },
  ],
  edges: [{ id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", label: "crosses" }],
};

async function openCanvas(page: Page) {
  await page.goto("/");
  await openMockVault(page);
  await page.waitForFunction(() => "__mosaic" in window);
  await page.evaluate(async (canvas) => {
    const m = (
      window as unknown as {
        __mosaic: {
          mockInvoke(command: string, args: object): Promise<unknown>;
          useWorkspace: { getState(): { open(path: string, options: { newTab: boolean }): Promise<void> } };
        };
      }
    ).__mosaic;
    await m.mockInvoke("write_file", { path: "Crossing.canvas", content: JSON.stringify(canvas) });
    await m.useWorkspace.getState().open("Crossing.canvas", { newTab: true });
  }, CANVAS);
  await expect(page.locator(".edge-label", { hasText: "crosses" })).toBeAttached();
  await expect(page.locator('[data-id="mid"]')).toBeVisible();
}

/** What the pointer would land on at a point: "edge", "label", or the id of a card or group. */
type Probe = {
  crossing?: true;
  along?: number;
  card?: string;
  dx?: number;
  dy?: number;
  label?: true;
  dyFromLine?: number;
};
function hitAt(page: Page, probe: Probe) {
  return page.evaluate((p) => {
    let x: number;
    let y: number;
    if (p.label) {
      const r = document.querySelector(".edge-label")!.getBoundingClientRect();
      [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
    } else if (p.card) {
      const r = document.querySelector(`.react-flow__node[data-id="${p.card}"]`)!.getBoundingClientRect();
      // A negative dy counts from the bottom edge.
      const dy = p.dy ?? 0;
      [x, y] = [r.x + (p.dx ?? 0), dy < 0 ? r.bottom + dy : r.y + dy];
    } else if (p.crossing) {
      // On the line where it crosses the middle card, halfway between the card's edge and the label.
      const card = document.querySelector('.react-flow__node[data-id="mid"]')!.getBoundingClientRect();
      const label = document.querySelector(".edge-label")!.getBoundingClientRect();
      [x, y] = [(card.left + label.left) / 2, label.y + label.height / 2 + (p.dyFromLine ?? 0)];
    } else {
      const path = document.querySelector<SVGPathElement>(".react-flow__edge-path")!;
      const m = path.getScreenCTM()!;
      const q = path.getPointAtLength(path.getTotalLength() * (p.along ?? 0.5));
      [x, y] = [q.x * m.a + m.e, q.y * m.d + m.f + (p.dyFromLine ?? 0)];
    }
    const el = document.elementFromPoint(x, y)!;
    if (el.closest(".edge-label")) return "label";
    if (el.closest(".react-flow__edge")) return "edge";
    return (el.closest(".react-flow__node") as HTMLElement | null)?.dataset.id ?? el.className.toString();
  }, probe);
}

test("connections, arrowheads and labels draw over cards; groups stay behind", async ({ page }) => {
  await openCanvas(page);

  // The line crossing the middle card, and the arrowhead at the target's border, are on top.
  expect(await hitAt(page, { crossing: true })).toBe("edge");
  expect(await hitAt(page, { along: 0.995 })).toBe("edge");
  // The label sits over the card it lands on.
  expect(await hitAt(page, { label: true })).toBe("label");
  // Away from the line, the card is still the card, so its text stays editable.
  expect(await hitAt(page, { card: "mid", dx: 30, dy: 25 })).toBe("mid");
  expect(await hitAt(page, { crossing: true, dyFromLine: 20 })).toBe("mid");
  // Groups stay behind the cards inside them.
  expect(await hitAt(page, { card: "a", dx: 80, dy: 20 })).toBe("a");
  expect(await hitAt(page, { card: "g", dx: 20, dy: -20 })).toBe("g");

  // Selecting the target card doesn't lift it over the arrow into it.
  await page.locator('[data-id="b"]').click({ position: { x: 80, y: 20 } });
  await expect(page.locator('[data-id="b"]')).toHaveClass(/selected/);
  expect(await hitAt(page, { along: 0.995 })).toBe("edge");

  // Selecting the group doesn't lift it over its cards.
  await page.locator('[data-id="g"]').click({ position: { x: 20, y: 40 } });
  await expect(page.locator('[data-id="g"]')).toHaveClass(/selected/);
  expect(await hitAt(page, { card: "a", dx: 80, dy: 20 })).toBe("a");
  expect(await hitAt(page, { crossing: true })).toBe("edge");
});
