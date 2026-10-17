// @vitest-environment jsdom
// Runs fixtures/contract.json against the browser mock. crates/mosaic-core/tests/contract.rs runs
// the same scenarios against the real core, so the mock can't quietly behave differently.
import { expect, test } from "vitest";
import shared from "../../../fixtures/contract.json";
import { mockInvoke, mockPropose } from "./mock";

type Step = {
  cmd?: string;
  args?: Record<string, unknown>;
  expect?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  agent_proposes?: { path: string; content: string };
};

/** `$last.<field>` and `$proposal` in step arguments. */
function resolve(args: Record<string, unknown>, last: Record<string, unknown>, proposal: number | null) {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k,
      v === "$proposal" ? proposal : typeof v === "string" && v.startsWith("$last.") ? last[v.slice(6)] : v,
    ]),
  );
}

for (const scenario of shared.scenarios) {
  test(`mock: ${scenario.name}`, async () => {
    for (const [path, content] of Object.entries(scenario.files))
      await mockInvoke("create_file", { path, content, root: null });
    let last: Record<string, unknown> = {};
    let proposal: number | null = null;
    for (const [i, step] of (scenario.steps as Step[]).entries()) {
      const at = `${scenario.name}, step ${i + 1}`;
      if (step.agent_proposes) {
        proposal = mockPropose(step.agent_proposes.path, step.agent_proposes.content);
        continue;
      }
      const run = mockInvoke(step.cmd!, resolve(step.args ?? {}, last, proposal));
      if (step.error) {
        await expect(run, at).rejects.toMatchObject({ code: step.error });
        continue;
      }
      const value = await run;
      if (step.expect) expect(value, at).toMatchObject(step.expect);
      if ("result" in step) expect(value, at).toEqual(step.result);
      last = (value ?? {}) as Record<string, unknown>;
    }
  });
}
