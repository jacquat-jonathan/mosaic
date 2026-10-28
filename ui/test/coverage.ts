import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll } from "vitest";

// Vite instruments both Vitest workers and the browser with the same Istanbul
// transform. Persist each worker's map so NYC can merge the two test layers.
afterAll(() => {
  if (process.env.VITE_COVERAGE !== "true") return;
  const coverage = (globalThis as { __coverage__?: Record<string, unknown> }).__coverage__;
  if (!coverage) throw new Error("Unit coverage was requested, but the test worker was not instrumented");
  const directory = path.resolve(import.meta.dirname, "../.nyc_output");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `unit-${process.pid}-${randomUUID()}.json`), JSON.stringify(coverage));
});
