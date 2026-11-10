import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, distribution, workloadFingerprint, validateCoreSamples, requireSameSource } from "./report.mjs";
const report = (values) => ({
  schema: 2,
  source: { dirty: false },
  workload: "same-workload",
  compatibility: "same-runner-and-fixture",
  metrics: { search: { unit: "ms", ...distribution(values) } },
});
test("deliberate slowdown is detected without making ordinary noise a gate", () => {
  const baseline = report([20, 21, 19, 20, 22]);
  assert.equal(compare(baseline, report([40, 42, 38, 40, 44]))[0].status, "regression signal");
  assert.equal(compare(baseline, report([21, 22, 20, 21, 23]))[0].status, "within provisional budget");
  assert.equal(compare(baseline, report([40]))[0].status, "insufficient samples");
});
test("incomparable runs, dropped metrics and invalid samples cannot silently pass", () => {
  const baseline = report([1, 2, 3, 4, 5]);
  assert.throws(() => compare(baseline, { ...baseline, compatibility: "other-cpu" }), /Incompatible/);
  assert.equal(compare(baseline, { ...baseline, metrics: {} })[0].status, "missing");
  assert.throws(() => distribution([]));
  assert.throws(() => distribution([NaN]));
  assert.throws(() => distribution([-1]));
});

test("distribution uses a conventional median and nearest-rank p95", () => {
  assert.equal(distribution([4, 1, 3, 2]).median, 2.5);
  assert.equal(distribution([4, 1, 3, 2]).p95, 4);
});

test("dirty calibration and changed workloads need explicit handling", () => {
  const baseline = report([20, 21, 19, 20, 22]);
  const dirty = { ...baseline, source: { dirty: true } };
  assert.throws(() => compare(baseline, dirty), /Dirty reports/);
  assert.equal(compare(baseline, dirty, { allowDirty: true })[0].status, "within provisional budget");
  assert.throws(() => compare(baseline, { ...baseline, workload: "changed fixture code" }), /Incompatible/);
  const core = `production A
// PERFORMANCE WORKLOAD BEGIN search
search 5000 notes
// PERFORMANCE WORKLOAD END search
// PERFORMANCE WORKLOAD BEGIN concurrent
2 indexers
// PERFORMANCE WORKLOAD END concurrent`;
  assert.equal(workloadFingerprint(core, {}), workloadFingerprint(core.replace("production A", "production B"), {}));
  assert.notEqual(workloadFingerprint(core, {}), workloadFingerprint(core.replace("5000", "1000"), {}));
  assert.notEqual(workloadFingerprint(core, {}), workloadFingerprint(core, { browser: "changed" }));
  assert.throws(() => workloadFingerprint("", {}), /markers/);
});
test("invalid artifact statistics cannot masquerade as within budget", () => {
  const baseline = report([20, 21, 19, 20, 22]);
  for (const patch of [{ median: null }, { p95: -1 }, { count: 1000 }, { samples: [] }, { unit: "seconds" }]) {
    const bad = structuredClone(baseline);
    Object.assign(bad.metrics.search, patch);
    assert.throws(() => compare(baseline, bad), /Invalid/);
  }
});

test("missing or duplicated core metrics cannot hide behind a correct total count", () => {
  const samples = Array.from({ length: 5 }, (_, repetition) => [
    ...["core.cold_index_5000", "core.warm_index_5000", "core.burst_100_sync", "core.concurrent_indexers_5000_40_edits"].map((name) => ({ name, unit: "ms", value: 1, repetition })),
    ...Array.from({ length: 20 }, () => ({ name: "core.search_5000", unit: "ms", value: 1, repetition })),
  ]).flat();
  validateCoreSamples(samples, 5);
  const bad = structuredClone(samples);
  bad[0] = { ...bad[1] };
  assert.throws(() => validateCoreSamples(bad, 5), /Missing core/);
  assert.throws(() => validateCoreSamples(samples.slice(1), 5), /Missing core/);
});

test("mixed or missing stage provenance is rejected", () => {
  const identity = { commit: "abc", diffSha256: "def", workload: "ghi" };
  requireSameSource(identity, { ...identity });
  assert.throws(() => requireSameSource(undefined, identity), /identity/);
  assert.throws(() => requireSameSource(identity, { ...identity, diffSha256: "new edits" }), /identity/);
  assert.throws(() => requireSameSource(identity, { ...identity, workload: "new benchmark" }), /identity/);
});
