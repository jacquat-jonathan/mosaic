import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fixtureConfig = JSON.parse(fs.readFileSync(path.join(root, "scripts/performance/fixture.json")));
export function distribution(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v) || v < 0)) throw new Error("Invalid samples");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    min: sorted[0],
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
    samples: values,
  };
}
export function validateCoreSamples(samples, repetitions) {
  if (!Number.isInteger(repetitions) || repetitions < 5 || repetitions > 30)
    throw new Error("Invalid core repetition count");
  const counts = {
    "core.cold_index_5000": 1,
    "core.warm_index_5000": 1,
    "core.search_5000": fixtureConfig.core.searchesPerRepetition,
    "core.burst_100_sync": 1,
    "core.concurrent_indexers_5000_40_edits": 1,
  };
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const [name, count] of Object.entries(counts)) {
      const values = samples.filter((sample) => sample.repetition === repetition && sample.name === name);
      if (values.length !== count || values.some((sample) => sample.unit !== "ms"))
        throw new Error(`Missing core measurements: ${name}, repetition ${repetition}`);
      distribution(values.map((sample) => sample.value));
    }
  }
  if (samples.length !== repetitions * Object.values(counts).reduce((sum, count) => sum + count, 0))
    throw new Error("Unexpected core measurements");
}
export function workloadFingerprint(coreSource, harnessFiles) {
  const sections = ["search", "concurrent"].map((name) => {
    const begin = `// PERFORMANCE WORKLOAD BEGIN ${name}`;
    const end = `// PERFORMANCE WORKLOAD END ${name}`;
    const start = coreSource.indexOf(begin);
    const stop = coreSource.indexOf(end, start);
    if (start < 0 || stop < start || coreSource.indexOf(begin, start + begin.length) >= 0)
      throw new Error(`Missing or ambiguous benchmark markers: ${name}`);
    return coreSource.slice(start + begin.length, stop).trim();
  });
  return digest(JSON.stringify({ sections, harnessFiles }));
}
function validateReport(report, allowDirty) {
  if (report.schema !== 2 || typeof report.compatibility !== "string" || !report.compatibility ||
      typeof report.workload !== "string" || !report.workload || typeof report.source?.dirty !== "boolean")
    throw new Error("Invalid report schema or provenance");
  if (report.source.dirty && !allowDirty)
    throw new Error("Dirty reports are calibration only; use --allow-dirty explicitly for a local experiment");
  if (!report.metrics || typeof report.metrics !== "object" || Array.isArray(report.metrics))
    throw new Error("Invalid metrics");
  for (const [name, metric] of Object.entries(report.metrics)) {
    if (!["ms", "bytes"].includes(metric?.unit) || !Array.isArray(metric.samples))
      throw new Error(`Invalid metric: ${name}`);
    const actual = distribution(metric.samples);
    for (const key of ["count", "min", "median", "p95", "max"])
      if (metric[key] !== actual[key]) throw new Error(`Invalid metric summary: ${name}.${key}`);
  }
}
export function compare(baseline, current, { allowDirty = false } = {}) {
  validateReport(baseline, allowDirty);
  validateReport(current, allowDirty);
  if (baseline.compatibility !== current.compatibility || baseline.workload !== current.workload) {
    throw new Error("Incompatible fixture, runner or tools; record a separate baseline");
  }
  const rows = [];
  for (const [name, metric] of Object.entries(current.metrics)) {
    const prior = baseline.metrics[name];
    if (!prior) {
      rows.push({ name, status: "new" });
      continue;
    }
    if (metric.unit !== prior.unit) throw new Error(`Unit mismatch: ${name}`);
    const budget = fixtureConfig.budget;
    const enough =
      metric.unit === "bytes" ||
      (prior.count >= budget.minimumTimingSamples && metric.count >= budget.minimumTimingSamples);
    const margin = metric.unit === "bytes" ? budget.minimumSizeDeltaBytes : budget.minimumTimingDeltaMs;
    const regression =
      enough &&
      ["median", "p95"].some(
        (k) => metric[k] > prior[k] * (1 + budget.relativeIncrease) && metric[k] - prior[k] > margin,
      );
    rows.push({
      name,
      status: !enough ? "insufficient samples" : regression ? "regression signal" : "within provisional budget",
      baselineMedian: prior.median,
      currentMedian: metric.median,
      baselineP95: prior.p95,
      currentP95: metric.p95,
    });
  }
  for (const name of Object.keys(baseline.metrics))
    if (!(name in current.metrics)) rows.push({ name, status: "missing" });
  return rows;
}
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
function currentWorkload() {
  return workloadFingerprint(
    fs.readFileSync(path.join(root, "crates/mosaic-core/src/index.rs"), "utf8"),
    Object.fromEntries([
      "scripts/bench.sh", "scripts/performance/report.mjs", "ui/perf/latency.spec.ts", "ui/playwright.perf.config.ts",
    ].map((file) => [file, digest(fs.readFileSync(path.join(root, file)))])),
  );
}
function runnerIdentity() {
  return {
    platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model,
    cores: os.cpus().length, memoryBytes: os.totalmem(), image: process.env.ImageVersion || "local",
  };
}
export function measurementSource() {
  return {
    commit: run("git", ["rev-parse", "HEAD"]),
    diffSha256: digest(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
    workload: currentWorkload(),
    runner: runnerIdentity(),
    node: process.version,
  };
}
export function requireSameSource(expected, actual) {
  if (!expected || JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("Measurements have missing or changed source/workload identity; rerun all measurement stages");
}
function main() {
  const [command, destination = "target/performance", second] = process.argv.slice(2);
  if (command === "source") {
    console.log(JSON.stringify(measurementSource()));
  } else if (command === "build") {
    const source = measurementSource();
    execFileSync("pnpm", ["--dir", "ui", "build"], { cwd: root, stdio: "inherit" });
    requireSameSource(source, measurementSource());
    fs.writeFileSync(path.join(root, "ui/dist/performance-source.json"), JSON.stringify({
      source, node: process.version, pnpm: run("pnpm", ["--version"]),
    }));
  } else if (command === "core") {
    fs.mkdirSync(destination, { recursive: true });
    const count = Number(process.env.MOSAIC_PERF_SAMPLES || 5);
    if (!Number.isInteger(count) || count < 5 || count > 30) throw new Error("Use 5–30 repetitions");
    const source = measurementSource();
    const rustVersions = new Set();
    const raw = [];
    for (let sample = 0; sample < count; sample++) {
      const result = spawnSync("bash", ["scripts/bench.sh"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, MOSAIC_PERF_REPORT: "1" },
      });
      fs.writeFileSync(path.join(destination, `core-${sample}.log`), `${result.stdout || ""}\n${result.stderr || ""}`);
      if (result.status !== 0) throw new Error(`Core benchmark failed; inspect core-${sample}.log`);
      for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
        const toolOffset = line.indexOf("MOSAIC_PERF_RUST ");
        if (toolOffset >= 0) rustVersions.add(line.slice(toolOffset + 17).trim());
        const offset = line.indexOf("MOSAIC_PERF ");
        if (offset >= 0) raw.push({ ...JSON.parse(line.slice(offset + 12)), repetition: sample });
      }
    }
    validateCoreSamples(raw, count);
    requireSameSource(source, measurementSource());
    if (rustVersions.size !== 1) throw new Error("Missing or mixed measured Rust toolchain");
    fs.writeFileSync(path.join(destination, "core.json"), JSON.stringify({ source, rust: [...rustVersions][0], samples: raw }, null, 2));
  } else if (command === "report") {
    const core = JSON.parse(fs.readFileSync(path.join(destination, "core.json")));
    const raw = core.samples;
    const source = measurementSource();
    requireSameSource(core.source, source);
    if (typeof core.rust !== "string" || !core.rust.startsWith("rustc ")) throw new Error("Missing measured Rust version");
    validateCoreSamples(raw, Math.max(...raw.map((sample) => sample.repetition)) + 1);
    const browser = JSON.parse(fs.readFileSync(path.join(destination, "browser.json")));
    const build = JSON.parse(fs.readFileSync(path.join(root, "ui/dist/performance-source.json")));
    requireSameSource(browser.source, source);
    requireSameSource(build.source, source);
    for (const name of [
      "browser.mock_external_edit_to_screen_1000",
      "browser.mock_burst_50_to_screen_1000",
      "browser.mock_vault_switch_1000",
    ]) {
      if (
        browser.samples.filter((s) => s.name === name && s.unit === "ms").length !== fixtureConfig.browser.repetitions
      )
        throw new Error(`Missing browser measurements: ${name}`);
    }
    raw.push(...browser.samples);
    const chunks = files(path.join(root, "ui/dist"))
      .filter((f) => /\.(js|css)$/.test(f))
      .map((f) => ({
        path: path.relative(path.join(root, "ui/dist"), f),
        bytes: fs.statSync(f).size,
        gzipBytes: gzipSync(fs.readFileSync(f)).length,
      }))
      .sort((a, b) => b.bytes - a.bytes);
    raw.push(
      { name: "bundle.js_css_total", unit: "bytes", value: chunks.reduce((n, f) => n + f.bytes, 0) },
      { name: "bundle.js_css_gzip", unit: "bytes", value: chunks.reduce((n, f) => n + f.gzipBytes, 0) },
    );
    const metrics = {};
    for (const entry of raw) {
      metrics[entry.name] ??= { unit: entry.unit, values: [] };
      if (metrics[entry.name].unit !== entry.unit) throw new Error("Mixed units");
      metrics[entry.name].values.push(entry.value);
    }
    for (const [name, value] of Object.entries(metrics))
      metrics[name] = { unit: value.unit, ...distribution(value.values) };
    const tools = {
      rust: core.rust,
      node: build.node,
      pnpm: build.pnpm,
      browser: browser.version,
    };
    const runner = source.runner;
    const fixture = fixtureConfig;
    const workload = source.workload;
    const report = {
      schema: 2,
      recordedAt: new Date().toISOString(),
      source: {
        commit: run("git", ["rev-parse", "HEAD"]),
        dirty: !!run("git", ["status", "--porcelain"]),
        diffSha256: digest(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
        benchmarkFiles: Object.fromEntries(
          [
            "crates/mosaic-core/src/index.rs",
            "ui/perf/latency.spec.ts",
            "ui/playwright.perf.config.ts",
            "scripts/performance/report.mjs",
            "scripts/performance/fixture.json",
          ].map((p) => [p, digest(fs.readFileSync(path.join(root, p)))]),
        ),
      },
      fixture,
      runner,
      tools,
      workload,
      compatibility: digest(JSON.stringify({ fixture, runner, tools, workload })),
      metrics,
      chunks,
      notes: [
        "Cold index means empty index database, not flushed OS disk cache.",
        "Browser measurements use Vite and in-memory mock IPC, not packaged WKWebView.",
        "Shared runner timings are reporting-only; 25% + absolute margin is provisional, not a release gate.",
      ],
    };
    fs.writeFileSync(path.join(destination, "report.json"), JSON.stringify(report, null, 2) + "\n");
    const summary = [
      "## Performance report",
      "",
      `Source: ${report.source.commit}${report.source.dirty ? " (dirty benchmark worktree)" : ""}`,
      "",
      "| Measurement | Samples | Median | p95 | Unit |",
      "|---|---:|---:|---:|---|",
      ...Object.entries(metrics).map(
        ([n, m]) => `| ${n} | ${m.count} | ${m.median.toFixed(2)} | ${m.p95.toFixed(2)} | ${m.unit} |`,
      ),
      "",
      ...report.notes.map((n) => `- ${n}`),
    ].join("\n");
    fs.writeFileSync(path.join(destination, "summary.md"), summary + "\n");
    console.log(summary);
  } else if (command === "compare") {
    if (!second) throw new Error("compare BASELINE.json CURRENT.json");
    const rows = compare(JSON.parse(fs.readFileSync(destination)), JSON.parse(fs.readFileSync(second)), {
      allowDirty: process.argv.includes("--allow-dirty"),
    });
    console.log(JSON.stringify(rows, null, 2));
    if (process.argv.includes("--strict") && rows.some((r) => ["regression signal", "missing", "new", "insufficient samples"].includes(r.status)))
      process.exitCode = 1;
  } else throw new Error("Use core OUTPUT_DIR, build, report OUTPUT_DIR, or compare BASELINE.json CURRENT.json [--strict]");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
