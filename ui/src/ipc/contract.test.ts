// @vitest-environment jsdom
// Both runners consume every scenario, including errors and post-failure state assertions.
import { expect, test } from "vitest";
import shared from "../../../fixtures/contract.json";
import { mockInvoke, mockPropose, mockAgentInvoke, mockExternalDirectory, resetMock } from "./mock";

type Step = {
  cmd?: string;
  args?: Record<string, unknown>;
  expect?: unknown;
  result?: unknown;
  error?: string;
  save?: string;
  actor?: string;
  external_directory?: string;
  agent_proposes?: { path: string; content: string };
};
function lookup(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => {
    if (v === null || typeof v !== "object" || !(key in v)) throw new Error(`unknown fixture reference: ${path}`);
    return (v as Record<string, unknown>)[key];
  }, value);
}
function resolve(value: unknown, last: unknown, proposal: number | null, saved: Record<string, unknown>): unknown {
  if (value === "$proposal") {
    if (proposal === null) throw new Error("no proposal yet");
    return proposal;
  }
  if (typeof value === "string" && value.startsWith("$last.")) return lookup(last, value.slice(6));
  if (typeof value === "string" && value.startsWith("$saved.")) return lookup(saved, value.slice(7));
  if (Array.isArray(value)) return value.map((v) => resolve(v, last, proposal, saved));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, last, proposal, saved)]));
  return value;
}
for (const scenario of shared.scenarios) {
  test(`mock: ${scenario.name}`, async () => {
    resetMock();
    for (const [path, content] of Object.entries(scenario.files))
      await mockInvoke("create_file", { path, content, root: null });
    if ("rules" in scenario) await mockInvoke("set_agent_rules", { rules: scenario.rules });
    let last: unknown = null;
    let proposal: number | null = null;
    const saved: Record<string, unknown> = {};
    for (const [i, step] of (scenario.steps as Step[]).entries()) {
      const at = `${scenario.name}, step ${i + 1}`;
      if (step.agent_proposes) {
        proposal = mockPropose(step.agent_proposes.path, step.agent_proposes.content);
        continue;
      }
      if (step.external_directory) {
        mockExternalDirectory(step.external_directory);
        continue;
      }
      const args = resolve(step.args ?? {}, last, proposal, saved) as Record<string, unknown>;
      const run = (step.actor === "agent" ? mockAgentInvoke : mockInvoke)(step.cmd!, args);
      if (step.error) {
        await expect(run, at).rejects.toMatchObject({ code: step.error });
        continue;
      }
      const value = await run;
      if (step.expect) expect(value, at).toMatchObject(resolve(step.expect, last, proposal, saved) as object);
      if ("result" in step) expect(value, at).toEqual(resolve(step.result, last, proposal, saved));
      if (step.save) saved[step.save] = structuredClone(value);
      last = value;
    }
  });
}
