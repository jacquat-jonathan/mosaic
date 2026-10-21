// @vitest-environment jsdom

import { expect, test, vi } from "vitest";
import { renderChart } from "./visuals";

const { embed } = vi.hoisted(() => ({ embed: vi.fn().mockResolvedValue(undefined) }));

vi.mock("vega-embed", () => ({ default: embed }));

test("renders Vega-Lite with the CSP-safe expression interpreter", async () => {
  const el = document.createElement("div");

  await renderChart('{"data":{"values":[{"x":1}]},"mark":"bar"}', el, "Reports/chart.md");

  expect(embed).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.any(Object),
    expect.objectContaining({ ast: true }),
  );
});
